import { Injectable } from '@nestjs/common'
import { postInTransaction } from '@carwash/ledger'
import { Database } from '../db/database.ts'
import { journalEvents } from '../events/events.ts'
import { ApiError, notFound } from '../http/api-error.ts'
import { IdempotencyService, type Final, type OwnedKey } from '../idempotency/idempotency.service.ts'
import { Chart } from '../ledger/chart.service.ts'
import { findMerchant } from '../merchants/merchants.repository.ts'
import { insertAttempt, pendingAttempt } from '../payments/attempts.repository.ts'
import { AttemptsService } from '../payments/attempts.service.ts'
import { payoutView } from './payout.views.ts'
import { insertPayout, loadPayout, lockBalances, setPayoutJournal } from './payouts.repository.ts'

export interface PayoutInput {
  merchant: string
  amount?: number
  currency: string
}

const MAX_ROUNDS = 5

@Injectable()
export class PayoutsService {
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

  async create(owned: OwnedKey, input: PayoutInput): Promise<Final> {
    if (owned.payoutId === null) {
      await this.#db.transaction(async (client) => {
        const merchant = await findMerchant(client, input.merchant)
        if (!merchant) throw notFound(`merchant ${input.merchant}`)
        if (merchant.currency !== input.currency) {
          throw new ApiError(400, 'currency_mismatch', `merchant ${input.merchant} is paid in ${merchant.currency}`)
        }
        const bank = this.#chart.accounts(input.currency).bank
        const balance = (await lockBalances(client, [merchant.account_id, bank.id.toString()])).get(merchant.account_id)
        if (balance === undefined) throw new Error(`merchant ${input.merchant} has no balance row`)
        const payable = -balance
        if (input.amount === undefined && payable <= 0n) {
          throw new ApiError(409, 'nothing_to_pay_out', `merchant ${input.merchant} has nothing available for payout`)
        }
        const amount = input.amount === undefined ? payable : BigInt(input.amount)
        if (amount > payable) {
          throw new ApiError(409, 'insufficient_funds', `merchant ${input.merchant} has ${payable} available for payout`)
        }
        const payoutId = await insertPayout(client, merchant.id, amount, input.currency)
        const journalId = await postInTransaction(client, this.#chart.registry, {
          externalRef: `payout:${payoutId}`,
          entries: [
            { accountId: BigInt(merchant.account_id), amount },
            { accountId: bank.id, amount: -amount },
          ],
        })
        await setPayoutJournal(client, payoutId, journalId)
        await journalEvents(client, journalId)
        await insertAttempt(client, { kind: 'payout', payoutId, amount, currency: input.currency })
        await this.#idempotency.recordPoint(client, owned, 'payout_created', { payoutId })
      })
    }
    const payoutId = owned.payoutId!
    for (let round = 0; ; round++) {
      const attempt = await pendingAttempt(this.#db.pool, 'payout_id', payoutId, ['payout'])
      if (!attempt) break
      if (round >= MAX_ROUNDS) throw new Error(`payout ${payoutId} is still pending after ${round} rounds`)
      await this.#attempts.settle(attempt)
    }
    return this.#db.transaction(async (client) => {
      const payout = (await loadPayout(client, payoutId))!
      return this.#idempotency.finish(client, owned, { status: 200, body: payoutView(payout) })
    })
  }
}
