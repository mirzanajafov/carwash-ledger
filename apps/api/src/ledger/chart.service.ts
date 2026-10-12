import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import {
  AccountRegistry,
  createAccount,
  findAccounts,
  pgAccountLoader,
  sqlStateOf,
  type Account,
  type AccountType,
  type BalanceMode,
} from '@carwash/ledger'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { ApiError } from '../http/api-error.ts'
import type { FeeSchedule } from '../payments/fees.ts'

export interface CurrencyAccounts {
  receivable: Account
  fees: Account
  bank: Account
  pspFees: Account
  suspense: Account
}

interface Spec {
  role: keyof CurrencyAccounts
  name: string
  type: AccountType
  hot: boolean
}

const CHART: readonly Spec[] = [
  { role: 'receivable', name: 'psp_receivable', type: 'asset', hot: true },
  { role: 'fees', name: 'platform_fee_revenue', type: 'revenue', hot: true },
  { role: 'bank', name: 'bank', type: 'asset', hot: false },
  { role: 'pspFees', name: 'psp_fee_expense', type: 'expense', hot: false },
  { role: 'suspense', name: 'suspense', type: 'liability', hot: false },
]

export function merchantAccountCode(merchant: string): string {
  return `merchant_payable:${merchant}`
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
    if (!accounts) throw new ApiError(400, 'unsupported_currency', `${currency} is not a supported currency`)
    return accounts
  }

  async #ensure(currency: string): Promise<CurrencyAccounts> {
    const codes = CHART.map((spec) => `${spec.name}:${currency}`)
    for (const [index, spec] of CHART.entries()) {
      const found = await findAccounts(this.#db.pool, [codes[index]!])
      if (found.size > 0) continue
      const mode: BalanceMode = spec.hot ? this.#config.hotAccountMode : 'locked'
      try {
        await createAccount(this.#db.pool, { code: codes[index]!, type: spec.type, currency, balanceMode: mode, shards: this.#config.hotAccountShards })
        this.#logger.log(`created ${codes[index]} (${mode})`)
      } catch (error) {
        if (sqlStateOf(error) !== '23505') throw error
      }
    }
    const found = await findAccounts(this.#db.pool, codes)
    return Object.fromEntries(CHART.map((spec, index) => [spec.role, found.get(codes[index]!)!])) as unknown as CurrencyAccounts
  }
}
