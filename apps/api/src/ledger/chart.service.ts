import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { AccountRegistry, createAccount, findAccounts, pgAccountLoader, type Account, type AccountType, type BalanceMode } from '@carwash/ledger'
import { sqlStateOf } from '@carwash/pg'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { DomainError } from '../domain-errors.ts'
import type { FeeSchedule } from '../payments/fees.ts'

export interface CurrencyAccounts {
  receivable: Account
  fees: Account
  bank: Account
  pspFees: Account
  suspense: Account
}

interface Spec {
  name: string
  type: AccountType
  hot: boolean
}

const CHART: Record<keyof CurrencyAccounts, Spec> = {
  receivable: { name: 'psp_receivable', type: 'asset', hot: true },
  fees: { name: 'platform_fee_revenue', type: 'revenue', hot: true },
  bank: { name: 'bank', type: 'asset', hot: false },
  pspFees: { name: 'psp_fee_expense', type: 'expense', hot: false },
  suspense: { name: 'suspense', type: 'liability', hot: false },
}

@Injectable()
export class Chart implements OnModuleInit {
  readonly registry: AccountRegistry
  readonly feeSchedule: FeeSchedule
  readonly #db: Database
  readonly #config: ApiConfig
  readonly #byCurrency = new Map<string, CurrencyAccounts>()
  readonly #logger = new Logger('chart')

  constructor(db: Database, @Inject(API_CONFIG) config: ApiConfig) {
    this.#db = db
    this.#config = config
    this.registry = new AccountRegistry(pgAccountLoader(db.pool))
    this.feeSchedule = { bps: config.feeBps, fixed: config.feeFixed }
  }

  async onModuleInit(): Promise<void> {
    for (const currency of this.#config.currencies) this.#byCurrency.set(currency, await this.#ensure(currency))
  }

  accounts(currency: string): CurrencyAccounts {
    const accounts = this.#byCurrency.get(currency)
    if (!accounts) throw new DomainError('invalid', 'unsupported_currency', `${currency} is not a supported currency`)
    return accounts
  }

  async #ensure(currency: string): Promise<CurrencyAccounts> {
    return {
      receivable: await this.#ensureAccount(CHART.receivable, currency),
      fees: await this.#ensureAccount(CHART.fees, currency),
      bank: await this.#ensureAccount(CHART.bank, currency),
      pspFees: await this.#ensureAccount(CHART.pspFees, currency),
      suspense: await this.#ensureAccount(CHART.suspense, currency),
    }
  }

  async #ensureAccount(spec: Spec, currency: string): Promise<Account> {
    const code = `${spec.name}:${currency}`
    const existing = (await findAccounts(this.#db.pool, [code])).get(code)
    if (existing) return existing
    const mode: BalanceMode = spec.hot ? this.#config.hotAccountMode : 'locked'
    try {
      const created = await createAccount(this.#db.pool, { code, type: spec.type, currency, balanceMode: mode, shards: this.#config.hotAccountShards })
      this.#logger.log(`created ${code} (${mode})`)
      return created
    } catch (error) {
      if (sqlStateOf(error) !== '23505') throw error
      const raced = (await findAccounts(this.#db.pool, [code])).get(code)
      if (!raced) throw error
      return raced
    }
  }
}
