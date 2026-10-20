import { createPrisma, type PrismaClient } from '@carwash/db'
import { createTestDatabase, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import {
  AccountRegistry,
  BALANCE_MODES,
  createAccount,
  PgCtePoster,
  pgAccountLoader,
  PrismaApiPoster,
  PrismaCtePoster,
  PrismaSqlPoster,
  type Account,
  type BalanceMode,
  type EntryInput,
  type Poster,
} from '../src/index.ts'

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
  prisma: PrismaClient
  posters: Poster[]
  poster: Poster
  close(): Promise<void>
}

export async function openLedger(poolSize = 16): Promise<LedgerFixture> {
  const db = await createTestDatabase()
  const app = db.pool('ledger_app', poolSize)
  const prisma = createPrisma(db.url('ledger_app'), poolSize)
  const registry = new AccountRegistry(pgAccountLoader(app))
  const poster = new PgCtePoster(app, registry, PATIENT_RETRY)
  return {
    db,
    app,
    owner: db.pool('ledger_owner', 2),
    admin: db.pool('admin', 2),
    prisma,
    poster,
    posters: [
      poster,
      new PrismaApiPoster(prisma, registry, PATIENT_RETRY),
      new PrismaSqlPoster(prisma, registry, PATIENT_RETRY),
      new PrismaCtePoster(prisma, registry, PATIENT_RETRY),
    ],
    close: async () => {
      await prisma.$disconnect()
      await db.drop()
    },
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

export async function createAllModes(pool: pg.Pool, options: { merchants?: number; currency?: string } = {}) {
  const result = new Map<BalanceMode, ModeAccounts>()
  for (const mode of BALANCE_MODES) result.set(mode, await createModeAccounts(pool, mode, options))
  return result
}

export function capture(accounts: ModeAccounts, merchant: number, gross: bigint, fee: bigint): EntryInput[] {
  return [
    { accountId: accounts.receivable.id, amount: gross },
    { accountId: accounts.merchants[merchant % accounts.merchants.length]!.id, amount: -(gross - fee) },
    { accountId: accounts.fees.id, amount: -fee },
  ]
}

export async function inParallel<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await run(item)
    }
  })
  await Promise.all(workers)
}

export async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code'
  }
}
