import { Injectable } from '@nestjs/common'
import { insertAccount, postInTransaction, readBalance, sqlStateOf } from '@carwash/ledger'
import { Database } from '../db/database.ts'
import { journalEvents } from '../events/events.ts'
import { ApiError, notFound } from '../http/api-error.ts'
import { IdempotencyService, type Final, type OwnedKey } from '../idempotency/idempotency.service.ts'
import { Chart, merchantAccountCode } from '../ledger/chart.service.ts'
import { AttemptsService } from '../payments/attempts.service.ts'
import { loadPayout, payoutView, pendingAttempt } from '../payments/records.ts'

export interface PayoutInput {
  merchant: string
  amount?: number
  currency: string
}

export interface MerchantInput {
  code: string
  name: string
  currency: string
}

interface MerchantRow {
  id: string
  code: string
  name: string
  currency: string
  account_id: string
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

  async createMerchant(owned: OwnedKey, input: MerchantInput): Promise<Final> {
    this.#chart.accounts(input.currency)
    try {
      return await this.#db.transaction(async (client) => {
        const account = await insertAccount(client, {
          code: merchantAccountCode(input.code),
          type: 'liability',
          currency: input.currency,
          balanceMode: 'locked',
        })
        const { rows } = await client.query<MerchantRow>(
          'INSERT INTO merchants (code, name, currency, account_id) VALUES ($1, $2, $3, $4) RETURNING id::text, code, name, currency, account_id::text',
          [input.code, input.name, input.currency, account.id],
        )
        return this.#idempotency.finish(client, owned, { status: 200, body: this.#merchantView(rows[0]!, 0n) })
      })
    } catch (error) {
      if (sqlStateOf(error) === '23505') throw new ApiError(409, 'merchant_exists', `merchant ${input.code} already exists`)
      throw error
    }
  }

  async merchant(code: string) {
    const { rows } = await this.#db.pool.query<MerchantRow>('SELECT id::text, code, name, currency, account_id::text FROM merchants WHERE code = $1', [code])
    const merchant = rows[0]
    if (!merchant) throw notFound(`merchant ${code}`)
    const [account] = (await this.#chart.registry.resolve([BigInt(merchant.account_id)])).values()
    return this.#merchantView(merchant, -(await readBalance(this.#db.pool, account!)))
  }

  async create(owned: OwnedKey, input: PayoutInput): Promise<Final> {
    if (owned.payoutId === null) {
      await this.#db.transaction(async (client) => {
        const { rows } = await client.query<MerchantRow>('SELECT id::text, code, name, currency, account_id::text FROM merchants WHERE code = $1', [
          input.merchant,
        ])
        const merchant = rows[0]
        if (!merchant) throw notFound(`merchant ${input.merchant}`)
        if (merchant.currency !== input.currency) {
          throw new ApiError(400, 'currency_mismatch', `merchant ${input.merchant} is paid in ${merchant.currency}`)
        }
        const bank = this.#chart.accounts(input.currency).bank
        const locked = await client.query<{ account_id: string; amount: string }>(
          `SELECT b.account_id::text, b.amount::text FROM balances b WHERE b.account_id = ANY($1::bigint[]) ORDER BY b.account_id, b.shard FOR UPDATE`,
          [[merchant.account_id, bank.id.toString()]],
        )
        const payable = -BigInt(locked.rows.find((row) => row.account_id === merchant.account_id)!.amount)
        if (input.amount === undefined && payable <= 0n) {
          throw new ApiError(409, 'nothing_to_pay_out', `merchant ${input.merchant} has nothing available for payout`)
        }
        const amount = input.amount === undefined ? payable : BigInt(input.amount)
        if (amount > payable) {
          throw new ApiError(409, 'insufficient_funds', `merchant ${input.merchant} has ${payable} available for payout`)
        }
        const inserted = await client.query<{ id: string }>('INSERT INTO payouts (merchant_id, amount, currency) VALUES ($1, $2, $3) RETURNING id', [
          merchant.id,
          amount,
          input.currency,
        ])
        const payoutId = inserted.rows[0]!.id
        const journalId = await postInTransaction(client, this.#chart.registry, {
          externalRef: `payout:${payoutId}`,
          entries: [
            { accountId: BigInt(merchant.account_id), amount },
            { accountId: bank.id, amount: -amount },
          ],
        })
        await client.query('UPDATE payouts SET journal_id = $2 WHERE id = $1', [payoutId, journalId])
        await journalEvents(client, journalId)
        await client.query(`INSERT INTO attempts (kind, payout_id, amount, currency) VALUES ('payout', $1, $2, $3)`, [payoutId, amount, input.currency])
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

  #merchantView(merchant: MerchantRow, payable: bigint) {
    return {
      id: merchant.code,
      object: 'merchant',
      name: merchant.name,
      currency: merchant.currency,
      account: merchantAccountCode(merchant.code),
      payable: Number(payable),
    }
  }
}
