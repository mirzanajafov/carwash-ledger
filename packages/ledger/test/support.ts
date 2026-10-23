import { sqlStateOf } from '@carwash/pg'
import { createTestDatabase, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { assert } from 'vitest'
import { AccountRegistry, createAccount, PgCtePoster, pgAccountLoader, type Account, type BalanceMode, type EntryInput, type Poster } from '../src/index.ts'

const PATIENT_RETRY = { maxAttempts: 40, baseDelayMs: 2, maxDelayMs: 100 }

export interface ModeAccounts {
  mode: BalanceMode
  receivable: Account
  fees: Account
  merchants: Account[]
}

export interface LedgerFixture {
  db: TestDatabase
  app: pg.Pool
  owner: pg.Pool
  admin: pg.Pool
  poster: Poster
  close(): Promise<void>
}

export async function openLedger(poolSize = 16): Promise<LedgerFixture> {
  const db = await createTestDatabase()
  const app = db.pool('ledger_app', poolSize)
  return {
    db,
    app,
    owner: db.pool('ledger_owner', 2),
    admin: db.pool('admin', 2),
    poster: new PgCtePoster(app, new AccountRegistry(pgAccountLoader(app)), PATIENT_RETRY),
    close: () => db.drop(),
  }
}

export async function createModeAccounts(
  pool: pg.Pool,
  mode: BalanceMode,
  { merchants = 4, currency = 'EUR', shards = 8, prefix = '' } = {},
): Promise<ModeAccounts> {
  const code = (name: string) => `${prefix}${mode}:${name}:${currency}`
  const spec = { currency, balanceMode: mode, shards }
  return {
    mode,
    receivable: await createAccount(pool, { ...spec, code: code('psp_receivable'), type: 'asset' }),
    fees: await createAccount(pool, { ...spec, code: code('platform_fees'), type: 'revenue' }),
    merchants: await Promise.all(
      Array.from({ length: merchants }, (_, i) => createAccount(pool, { ...spec, balanceMode: 'locked', code: code(`merchant_${i}`), type: 'liability' })),
    ),
  }
}

export function capture(accounts: ModeAccounts, merchant: number, gross: bigint, fee: bigint): EntryInput[] {
  const payee = accounts.merchants[merchant % accounts.merchants.length]
  assert(payee)
  return [
    { accountId: accounts.receivable.id, amount: gross },
    { accountId: payee.id, amount: -(gross - fee) },
    { accountId: accounts.fees.id, amount: -fee },
  ]
}

export async function inParallel<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = items.values()
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (const item of queue) await run(item)
  })
  await Promise.all(workers)
}

export async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return sqlStateOf(error) ?? 'no-code'
  }
}
