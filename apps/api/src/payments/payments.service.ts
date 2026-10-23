import { Injectable } from '@nestjs/common'
import type { FailedPayment } from '@carwash/contracts'
import { sqlStateOf } from '@carwash/pg'
import type { ApiClientIdentity } from '../auth/api-keys.ts'
import { Database } from '../db/database.ts'
import { DomainError, notFound } from '../domain-errors.ts'
import { IdempotencyService, type Final, type OwnedKey } from '../idempotency/idempotency.service.ts'
import type { PaymentId, RefundId } from '../ids.ts'
import { Chart } from '../ledger/chart.service.ts'
import { findMerchant } from '../merchants/merchants.repository.ts'
import { insertAttempt, pendingCardAttempt, pendingRefundAttempt } from './attempts.repository.ts'
import { AttemptsService } from './attempts.service.ts'
import { platformFee } from './fees.ts'
import type { CaptureMode, Payment, PaymentStatus } from './payment.ts'
import { findPayment, findPaymentForUpdate, insertPayment, insertRefund, loadPayment, loadRefund, pendingRefundTotal } from './payments.repository.ts'
import { paymentView, refundView } from './payments.views.ts'

export interface CreatePaymentInput {
  amount: number
  currency: string
  merchant: string
  token: string
  capture?: CaptureMode
}

const MAX_ROUNDS = 5

function paymentFinal(payment: Payment, expected: readonly PaymentStatus[]): Final {
  if (payment.status === 'failed' && expected.includes('failed')) {
    const code = payment.failureReason ?? 'payment_failed'
    return { status: 402, body: { error: { code, message: `the payment failed: ${code}` }, payment: paymentView(payment) } satisfies FailedPayment }
  }
  if (!expected.includes(payment.status)) {
    throw new DomainError('upstream', 'psp_disagreement', `the PSP's answer left the payment ${payment.status}, and the disagreement is recorded as an anomaly`)
  }
  return { status: 200, body: paymentView(payment) }
}

function notCapturable(payment: Payment): DomainError {
  return new DomainError('conflict', 'payment_not_capturable', `payment ${payment.id} is ${payment.status}`)
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
    const capture = input.capture ?? 'auto'
    const paymentId = owned.paymentId ?? (await this.#startPayment(owned, input, capture))
    const expected: PaymentStatus[] = capture === 'auto' ? ['captured', 'failed'] : ['authorized', 'failed']
    return this.#drive(owned, paymentId, expected)
  }

  async capture(owned: OwnedKey, caller: ApiClientIdentity, requestedId: string, amount: number | undefined): Promise<Final> {
    const paymentId =
      owned.paymentId ??
      (await this.#startSettlement(owned, caller, requestedId, 'capture', (payment) => {
        const value = amount === undefined ? payment.amount : BigInt(amount)
        if (value > payment.amount) throw new DomainError('invalid', 'amount_too_large', 'a capture cannot exceed the authorized amount')
        this.#checkAmount(value)
        return value
      }))
    return this.#drive(owned, paymentId, ['captured', 'failed'])
  }

  async cancel(owned: OwnedKey, caller: ApiClientIdentity, requestedId: string): Promise<Final> {
    const paymentId = owned.paymentId ?? (await this.#startSettlement(owned, caller, requestedId, 'cancel', (payment) => payment.amount))
    return this.#drive(owned, paymentId, ['canceled'])
  }

  async refund(owned: OwnedKey, caller: ApiClientIdentity, paymentId: string, amount: number): Promise<Final> {
    const refundId = owned.refundId ?? (await this.#startRefund(owned, caller, paymentId, BigInt(amount)))
    for (let round = 0; ; round++) {
      const attempt = await pendingRefundAttempt(this.#db.pool, refundId)
      if (!attempt) break
      if (round >= MAX_ROUNDS) throw new Error(`refund ${refundId} is still pending after ${round} rounds`)
      await this.#attempts.settle(attempt)
    }
    return this.#db.transaction(async (client) => {
      const refund = await loadRefund(client, refundId)
      return this.#idempotency.finish(client, owned, { status: 200, body: refundView(refund) })
    })
  }

  async get(caller: ApiClientIdentity, paymentId: string) {
    return paymentView(this.#visible(await findPayment(this.#db.pool, paymentId), caller, paymentId))
  }

  #startPayment(owned: OwnedKey, input: CreatePaymentInput, capture: CaptureMode): Promise<PaymentId> {
    return this.#db.transaction(async (client) => {
      const merchant = await findMerchant(client, input.merchant)
      if (!merchant) throw notFound(`merchant ${input.merchant}`)
      if (merchant.currency !== input.currency) {
        throw new DomainError('invalid', 'currency_mismatch', `merchant ${input.merchant} takes ${merchant.currency}, not ${input.currency}`)
      }
      this.#chart.accounts(input.currency)
      const amount = BigInt(input.amount)
      this.#checkAmount(amount)
      const paymentId = await insertPayment(client, {
        clientId: owned.clientId,
        merchantId: merchant.id,
        amount,
        currency: input.currency,
        capture,
        token: input.token,
      })
      await insertAttempt(client, { kind: 'authorize', paymentId, amount, currency: input.currency })
      await this.#idempotency.recordPoint(client, owned, 'payment_created', { paymentId })
      return paymentId
    })
  }

  #startRefund(owned: OwnedKey, caller: ApiClientIdentity, paymentId: string, amount: bigint): Promise<RefundId> {
    return this.#db.transaction(async (client) => {
      const payment = this.#visible(await findPaymentForUpdate(client, paymentId), caller, paymentId)
      if (payment.status !== 'captured') throw new DomainError('conflict', 'payment_not_refundable', `payment ${payment.id} is ${payment.status}`)
      const available = payment.capturedAmount - payment.refundedAmount - (await pendingRefundTotal(client, payment.id))
      if (amount > available) {
        throw new DomainError('conflict', 'refund_exceeds_available', `at most ${available} can still be refunded on payment ${payment.id}`)
      }
      const refundId = await insertRefund(client, payment.id, amount)
      await insertAttempt(client, { kind: 'refund', paymentId: payment.id, refundId, amount, currency: payment.currency })
      await this.#idempotency.recordPoint(client, owned, 'refund_created', { paymentId: payment.id, refundId })
      return refundId
    })
  }

  async #startSettlement(
    owned: OwnedKey,
    caller: ApiClientIdentity,
    paymentId: string,
    kind: 'capture' | 'cancel',
    amountFor: (payment: Payment) => bigint,
  ): Promise<PaymentId> {
    try {
      return await this.#db.transaction(async (client) => {
        const payment = this.#visible(await findPaymentForUpdate(client, paymentId), caller, paymentId)
        if (payment.status !== 'authorized') throw notCapturable(payment)
        const amount = amountFor(payment)
        await insertAttempt(client, { kind, paymentId: payment.id, amount, currency: payment.currency })
        await this.#idempotency.recordPoint(client, owned, `${kind}_created`, { paymentId: payment.id })
        return payment.id
      })
    } catch (error) {
      if (sqlStateOf(error) === '23505') {
        throw new DomainError('conflict', 'payment_not_capturable', `payment ${paymentId} already has a capture or cancel in progress or done`)
      }
      throw error
    }
  }

  async #drive(owned: OwnedKey, paymentId: PaymentId, expected: PaymentStatus[]): Promise<Final> {
    for (let round = 0; ; round++) {
      const attempt = await pendingCardAttempt(this.#db.pool, paymentId)
      if (!attempt) break
      if (round >= MAX_ROUNDS) throw new Error(`payment ${paymentId} still has a pending attempt after ${round} rounds`)
      await this.#attempts.settle(attempt)
    }
    return this.#db.transaction(async (client) => {
      const payment = await loadPayment(client, paymentId)
      return this.#idempotency.finish(client, owned, paymentFinal(payment, expected))
    })
  }

  #checkAmount(amount: bigint): void {
    if (platformFee(amount, this.#chart.feeSchedule) >= amount) {
      throw new DomainError('invalid', 'amount_too_small', 'the amount does not cover the platform fee')
    }
  }

  #visible(payment: Payment | undefined, caller: ApiClientIdentity, paymentId: string): Payment {
    if (!payment || (caller.scope !== 'admin' && payment.clientId !== caller.id)) throw notFound(`payment ${paymentId}`)
    return payment
  }
}
