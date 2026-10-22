import { Injectable } from '@nestjs/common'
import { insertAccount, readBalance, sqlStateOf } from '@carwash/ledger'
import { firstRow } from '@carwash/pg'
import { Database } from '../db/database.ts'
import { ApiError, notFound } from '../http/api-error.ts'
import { IdempotencyService, type Final, type OwnedKey } from '../idempotency/idempotency.service.ts'
import { merchantAccountCode } from '../ledger/account-codes.ts'
import { Chart } from '../ledger/chart.service.ts'

export interface MerchantInput {
  code: string
  name: string
  currency: string
}

export interface MerchantRow {
  id: string
  code: string
  name: string
  currency: string
  account_id: string
}

@Injectable()
export class MerchantsService {
  readonly #db: Database
  readonly #chart: Chart
  readonly #idempotency: IdempotencyService

  constructor(db: Database, chart: Chart, idempotency: IdempotencyService) {
    this.#db = db
    this.#chart = chart
    this.#idempotency = idempotency
  }

  async create(owned: OwnedKey, input: MerchantInput): Promise<Final> {
    this.#chart.accounts(input.currency)
    try {
      return await this.#db.transaction(async (client) => {
        const account = await insertAccount(client, {
          code: merchantAccountCode(input.code),
          type: 'liability',
          currency: input.currency,
          balanceMode: 'locked',
        })
        const inserted = await client.query<MerchantRow>(
          'INSERT INTO merchants (code, name, currency, account_id) VALUES ($1, $2, $3, $4) RETURNING id::text, code, name, currency, account_id::text',
          [input.code, input.name, input.currency, account.id],
        )
        return this.#idempotency.finish(client, owned, { status: 200, body: this.#view(firstRow(inserted), 0n) })
      })
    } catch (error) {
      if (sqlStateOf(error) === '23505') throw new ApiError(409, 'merchant_exists', `merchant ${input.code} already exists`)
      throw error
    }
  }

  async get(code: string) {
    const { rows } = await this.#db.pool.query<MerchantRow>('SELECT id::text, code, name, currency, account_id::text FROM merchants WHERE code = $1', [code])
    const merchant = rows[0]
    if (!merchant) throw notFound(`merchant ${code}`)
    const account = await this.#chart.registry.account(BigInt(merchant.account_id))
    return this.#view(merchant, -(await readBalance(this.#db.pool, account)))
  }

  #view(merchant: MerchantRow, payable: bigint) {
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
