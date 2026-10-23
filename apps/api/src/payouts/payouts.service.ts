import { Injectable } from '@nestjs/common'
import { lockStoredBalances, postInTransaction } from '@carwash/ledger'
import { Database } from '../db/database.ts'
import { journalEvents } from '../events/events.ts'
import { DomainError, notFound } from '../domain-errors.ts'
import { IdempotencyService, type Final, type OwnedKey } from '../idempotency/idempotency.service.ts'
import type { PayoutId } from '../ids.ts'
import { ChartService } from '../ledger/chart.service.ts'
import { findMerchant } from '../merchants/merchants.repository.ts'
import { insertAttempt, pendingPayoutAttempt } from '../payments/attempts.repository.ts'
import { AttemptsService } from '../payments/attempts.service.ts'
import { insertPayout, loadPayout, setPayoutJournal } from './payouts.repository.ts'
import { payoutView } from './payouts.views.ts'

export interface PayoutInput {
  merchant: string
  amount?: number
  currency: string
}

const MAX_ROUNDS = 5

@Injectable()
export class PayoutsService {
  readonly #db: Database
  readonly #chart: ChartService
  readonly #attempts: AttemptsService
  readonly #idempotency: IdempotencyService

  constructor(db: Database, chart: ChartService, attempts: AttemptsService, idempotency: IdempotencyService) {
    this.#db = db
    this.#chart = chart
    this.#attempts = attempts
    this.#idempotency = idempotency
  }

  async create(owned: OwnedKey, input: PayoutInput): Promise<Final> {
    const payoutId = owned.payoutId ?? (await this.#startPayout(owned, input))
    for (let round = 0; ; round++) {
      const attempt = await pendingPayoutAttempt(this.#db.pool, payoutId)
      if (!attempt) break
      if (round >= MAX_ROUNDS) throw new Error(`payout ${payoutId} is still pending after ${round} rounds`)
      await this.#attempts.settle(attempt)
    }
    return this.#db.transaction(async (client) => {
      const payout = await loadPayout(client, payoutId)
      return this.#idempotency.finish(client, owned, { status: 200, body: payoutView(payout) })
    })
  }

  #startPayout(owned: OwnedKey, input: PayoutInput): Promise<PayoutId> {
    return this.#db.transaction(async (client) => {
      const merchant = await findMerchant(client, input.merchant)
      if (!merchant) throw notFound(`merchant ${input.merchant}`)
      if (merchant.currency !== input.currency) {
        throw new DomainError('invalid', 'currency_mismatch', `merchant ${input.merchant} is paid in ${merchant.currency}`)
      }
      const bank = this.#chart.accounts(input.currency).bank
      const balance = (await lockStoredBalances(client, [merchant.accountId, bank.id])).get(merchant.accountId)
      if (balance === undefined) throw new Error(`merchant ${input.merchant} has no balance row`)
      const payable = -balance
      if (input.amount === undefined && payable <= 0n) {
        throw new DomainError('conflict', 'nothing_to_pay_out', `merchant ${input.merchant} has nothing available for payout`)
      }
      const amount = input.amount === undefined ? payable : BigInt(input.amount)
      if (amount > payable) {
        throw new DomainError('conflict', 'insufficient_funds', `merchant ${input.merchant} has ${payable} available for payout`)
      }
      const payoutId = await insertPayout(client, { merchantId: merchant.id, amount, currency: input.currency })
      const journalId = await postInTransaction(client, this.#chart.registry, {
        externalRef: `payout:${payoutId}`,
        entries: [
          { accountId: merchant.accountId, amount },
          { accountId: bank.id, amount: -amount },
        ],
      })
      await setPayoutJournal(client, payoutId, journalId)
      await journalEvents(client, journalId)
      await insertAttempt(client, { kind: 'payout', payoutId, amount, currency: input.currency })
      await this.#idempotency.recordPoint(client, owned, 'payout_created', { payoutId })
      return payoutId
    })
  }
}
