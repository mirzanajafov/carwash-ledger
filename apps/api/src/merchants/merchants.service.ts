import { Injectable } from '@nestjs/common'
import type { MerchantView } from '@carwash/contracts'
import { insertAccount, readBalance } from '@carwash/ledger'
import { sqlStateOf } from '@carwash/pg'
import { Database } from '../db/database.ts'
import { DomainError, notFound } from '../domain-errors.ts'
import { IdempotencyService, type Final, type OwnedKey } from '../idempotency/idempotency.service.ts'
import { merchantAccountCode } from '../ledger/account-codes.ts'
import { Chart } from '../ledger/chart.service.ts'
import type { Merchant } from './merchant.ts'
import { findMerchant, insertMerchant } from './merchants.repository.ts'

export interface MerchantInput {
  code: string
  name: string
  currency: string
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
        const merchant = await insertMerchant(client, { code: input.code, name: input.name, currency: input.currency, accountId: account.id })
        return this.#idempotency.finish(client, owned, { status: 200, body: this.#view(merchant, 0n) })
      })
    } catch (error) {
      if (sqlStateOf(error) === '23505') throw new DomainError('conflict', 'merchant_exists', `merchant ${input.code} already exists`)
      throw error
    }
  }

  async get(code: string) {
    const merchant = await findMerchant(this.#db.pool, code)
    if (!merchant) throw notFound(`merchant ${code}`)
    const account = await this.#chart.registry.account(merchant.accountId)
    return this.#view(merchant, -(await readBalance(this.#db.pool, account)))
  }

  #view(merchant: Merchant, payable: bigint): MerchantView {
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
