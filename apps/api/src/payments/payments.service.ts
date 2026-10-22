import { Injectable } from '@nestjs/common'
import { sqlStateOf } from '@carwash/ledger'
import { firstRow } from '@carwash/pg'
import type { ApiClientIdentity } from '../auth/api-keys.ts'
import { Database } from '../db/database.ts'
import { ApiError, notFound } from '../http/api-error.ts'
import { IdempotencyService, type Final, type OwnedKey } from '../idempotency/idempotency.service.ts'
import { Chart } from '../ledger/chart.service.ts'
import { AttemptsService } from './attempts.service.ts'
import { platformFee } from './fees.ts'
import type { PaymentStatus } from './payment-state.ts'
import { loadPayment, loadRefund, paymentFinal, paymentView, pendingAttempt, refundView, type PaymentRecord } from './records.ts'

export interface CreatePaymentInput {
  amount: number
  currency: string
  merchant: string
  token: string
  capture: 'auto' | 'manual'
}

const CARD_KINDS = ['authorize', 'capture', 'cancel'] as const
const MAX_ROUNDS = 5

function notCapturable(payment: PaymentRecord): ApiError {
  return new ApiError(409, 'payment_not_capturable', `payment ${payment.id} is ${payment.status}`)
}

@Injectable()
export class PaymentsService {
  readonly #db: Database
  readonly #chart: Chart
  readonly #attempts: AttemptsService
  readonly #idempotency: IdempotencyService

  constructor(db: Database, chart: Chart, attempts: AttemptsService, idempotency: IdempotencyService) {
    this.#db = db
    this.#chart = chart
    this.#attempts = attempts
    this.#idempotency = idempotency
  }

  async create(owned: OwnedKey, input: CreatePaymentInput): Promise<Final> {
    if (owned.paymentId === null) {
      await this.#db.transaction(async (client) => {
        const { rows } = await client.query<{ id: string; currency: string }>('SELECT id::text, currency FROM merchants WHERE code = $1', [input.merchant])
        const merchant = rows[0]
        if (!merchant) throw notFound(`merchant ${input.merchant}`)
        if (merchant.currency !== input.currency) {
          throw new ApiError(400, 'currency_mismatch', `merchant ${input.merchant} takes ${merchant.currency}, not ${input.currency}`)
        }
        this.#chart.accounts(input.currency)
        this.#checkAmount(BigInt(input.amount))
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO payments (client_id, merchant_id, amount, currency, capture_mode, token)
           VALUES ($1, $2, $3, $4, $5::capture_mode, $6) RETURNING id`,
          [owned.clientId, merchant.id, input.amount, input.currency, input.capture, input.token],
        )
        const paymentId = firstRow(inserted).id
        await client.query(`INSERT INTO attempts (kind, payment_id, amount, currency) VALUES ('authorize', $1, $2, $3)`, [
          paymentId,
          input.amount,
          input.currency,
        ])
        await this.#idempotency.recordPoint(client, owned, 'payment_created', { paymentId })
      })
    }
    const expected: PaymentStatus[] = input.capture === 'auto' ? ['captured', 'failed'] : ['authorized', 'failed']
    return this.#drive(owned, owned.paymentId!, expected)
  }

  async capture(owned: OwnedKey, caller: ApiClientIdentity, paymentId: string, amount: number | undefined): Promise<Final> {
    if (owned.recoveryPoint === 'started') {
      await this.#startSettlement(owned, caller, paymentId, 'capture', (payment) => {
        const value = amount === undefined ? BigInt(payment.amount) : BigInt(amount)
        if (value > BigInt(payment.amount)) throw new ApiError(400, 'amount_too_large', 'a capture cannot exceed the authorized amount')
        this.#checkAmount(value)
        return value
      })
    }
    return this.#drive(owned, paymentId, ['captured', 'failed'])
  }

  async cancel(owned: OwnedKey, caller: ApiClientIdentity, paymentId: string): Promise<Final> {
    if (owned.recoveryPoint === 'started') {
      await this.#startSettlement(owned, caller, paymentId, 'cancel', (payment) => BigInt(payment.amount))
    }
    return this.#drive(owned, paymentId, ['canceled'])
  }

  async refund(owned: OwnedKey, caller: ApiClientIdentity, paymentId: string, amount: number): Promise<Final> {
    if (owned.refundId === null) {
      await this.#db.transaction(async (client) => {
        const payment = this.#visible(await loadPayment(client, paymentId, true), caller, paymentId)
        if (payment.status !== 'captured') throw new ApiError(409, 'payment_not_refundable', `payment ${payment.id} is ${payment.status}`)
        const { pending } = firstRow(
          await client.query<{ pending: string }>(
            `SELECT coalesce(sum(amount), 0)::text AS pending FROM refunds WHERE payment_id = $1 AND status = 'pending'`,
            [payment.id],
          ),
        )
        const available = BigInt(payment.captured_amount) - BigInt(payment.refunded_amount) - BigInt(pending)
        if (BigInt(amount) > available) {
          throw new ApiError(409, 'refund_exceeds_available', `at most ${available} can still be refunded on payment ${payment.id}`)
        }
        const inserted = await client.query<{ id: string }>('INSERT INTO refunds (payment_id, amount) VALUES ($1, $2) RETURNING id', [payment.id, amount])
        const refundId = firstRow(inserted).id
        await client.query(`INSERT INTO attempts (kind, payment_id, refund_id, amount, currency) VALUES ('refund', $1, $2, $3, $4)`, [
          payment.id,
          refundId,
          amount,
          payment.currency,
        ])
        await this.#idempotency.recordPoint(client, owned, 'refund_created', { paymentId: payment.id, refundId })
      })
    }
    const refundId = owned.refundId!
    for (let round = 0; ; round++) {
      const attempt = await pendingAttempt(this.#db.pool, 'refund_id', refundId, ['refund'])
      if (!attempt) break
      if (round >= MAX_ROUNDS) throw new Error(`refund ${refundId} is still pending after ${round} rounds`)
      await this.#attempts.settle(attempt)
    }
    return this.#db.transaction(async (client) => {
      const refund = (await loadRefund(client, refundId))!
      return this.#idempotency.finish(client, owned, { status: 200, body: refundView(refund) })
    })
  }

  async get(caller: ApiClientIdentity, paymentId: string) {
    return paymentView(this.#visible(await loadPayment(this.#db.pool, paymentId), caller, paymentId))
  }

  async #startSettlement(
    owned: OwnedKey,
    caller: ApiClientIdentity,
    paymentId: string,
    kind: 'capture' | 'cancel',
    amountFor: (payment: PaymentRecord) => bigint,
  ): Promise<void> {
    try {
      await this.#db.transaction(async (client) => {
        const payment = this.#visible(await loadPayment(client, paymentId, true), caller, paymentId)
        if (payment.status !== 'authorized') throw notCapturable(payment)
        const amount = amountFor(payment)
        await client.query(`INSERT INTO attempts (kind, payment_id, amount, currency) VALUES ($1::attempt_kind, $2, $3, $4)`, [
          kind,
          payment.id,
          amount,
          payment.currency,
        ])
        await this.#idempotency.recordPoint(client, owned, `${kind}_created`, { paymentId: payment.id })
      })
    } catch (error) {
      if (sqlStateOf(error) === '23505') {
        throw new ApiError(409, 'payment_not_capturable', `payment ${paymentId} already has a capture or cancel in progress or done`)
      }
      throw error
    }
  }

  async #drive(owned: OwnedKey, paymentId: string, expected: PaymentStatus[]): Promise<Final> {
    for (let round = 0; ; round++) {
      const attempt = await pendingAttempt(this.#db.pool, 'payment_id', paymentId, CARD_KINDS)
      if (!attempt) break
      if (round >= MAX_ROUNDS) throw new Error(`payment ${paymentId} still has a pending attempt after ${round} rounds`)
      await this.#attempts.settle(attempt)
    }
    return this.#db.transaction(async (client) => {
      const payment = (await loadPayment(client, paymentId))!
      return this.#idempotency.finish(client, owned, paymentFinal(payment, expected))
    })
  }

  #checkAmount(amount: bigint): void {
    if (platformFee(amount, this.#chart.feeSchedule) >= amount) {
      throw new ApiError(400, 'amount_too_small', 'the amount does not cover the platform fee')
    }
  }

  #visible(payment: PaymentRecord | undefined, caller: ApiClientIdentity, paymentId: string): PaymentRecord {
    if (!payment || (caller.scope !== 'admin' && payment.client_id !== caller.id)) throw notFound(`payment ${paymentId}`)
    return payment
  }
}
