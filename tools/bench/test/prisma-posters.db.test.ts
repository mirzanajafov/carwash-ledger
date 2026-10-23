import { createPrisma, type PrismaClient } from '@carwash/db'
import { checkLedger, violations } from '@carwash/invariants'
import {
  AccountRegistry,
  BALANCE_MODES,
  createAccount,
  DuplicateJournalError,
  pgAccountLoader,
  readBalance,
  takeSnapshots,
  type Account,
  type BalanceMode,
  type EntryInput,
  type Poster,
} from '@carwash/ledger'
import { RetriesExhaustedError } from '@carwash/pg'
import { createTestDatabase, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { PrismaApiPoster, PrismaCtePoster, PrismaSqlPoster } from '../src/prisma-posters.ts'

const PATIENT_RETRY = { maxAttempts: 40, baseDelayMs: 2, maxDelayMs: 100 }

let db: TestDatabase
let app: pg.Pool
let prisma: PrismaClient
let posters: Poster[]

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  db = await createTestDatabase()
  cleanup.defer(() => db.drop())
  app = db.pool('ledger_app', 16)
  prisma = createPrisma(db.url('ledger_app'), 16)
  cleanup.defer(() => prisma.$disconnect())
  const registry = new AccountRegistry(pgAccountLoader(app))
  posters = [PrismaApiPoster, PrismaSqlPoster, PrismaCtePoster].map((Variant) => new Variant(prisma, registry, PATIENT_RETRY))
})

afterAll(() => cleanup.disposeAsync())

interface Accounts {
  receivable: Account
  fees: Account
  merchants: Account[]
}

async function accountsFor(poster: Poster, mode: BalanceMode, tag: string = mode): Promise<Accounts> {
  const spec = { currency: 'EUR', balanceMode: mode, shards: 8 }
  const code = (name: string) => `${poster.name}:${tag}:${name}`
  return {
    receivable: await createAccount(app, { ...spec, code: code('receivable'), type: 'asset' }),
    fees: await createAccount(app, { ...spec, code: code('fees'), type: 'revenue' }),
    merchants: await Promise.all(
      [0, 1, 2, 3].map((i) => createAccount(app, { ...spec, balanceMode: 'locked', code: code(`merchant_${i}`), type: 'liability' })),
    ),
  }
}

function capture(accounts: Accounts, merchant: number, gross: bigint, fee: bigint): EntryInput[] {
  const payee = accounts.merchants[merchant % accounts.merchants.length]
  assert(payee)
  return [
    { accountId: accounts.receivable.id, amount: gross },
    { accountId: payee.id, amount: -(gross - fee) },
    { accountId: accounts.fees.id, amount: -fee },
  ]
}

describe('the Prisma posters that E2 compares with pg-cte', () => {
  const journals = 120
  const gross = 1500n
  const fee = 40n

  for (const name of ['prisma-api', 'prisma-sql', 'prisma-cte']) {
    for (const mode of BALANCE_MODES) {
      it(`${name} keeps ${mode} balances exact under concurrent captures`, async () => {
        const poster = posters.find((p) => p.name === name)
        assert(poster)
        const accounts = await accountsFor(poster, mode)
        const refs = Array.from({ length: journals }, (_, i) => `${poster.name}:${mode}:${i}`)
        const queue = refs.values()
        const gaveUp: string[] = []
        await Promise.all(
          Array.from({ length: 16 }, async () => {
            for (const ref of queue) {
              try {
                await poster.post({ externalRef: ref, entries: capture(accounts, Number(ref.split(':').at(-1)), gross, fee) })
              } catch (error) {
                if (!(error instanceof RetriesExhaustedError)) throw error
                gaveUp.push(ref)
              }
            }
          }),
        )
        if (mode !== 'serializable') expect(gaveUp).toEqual([])
        if (mode === 'derived') await takeSnapshots(app)
        const posted = BigInt(journals - gaveUp.length)
        expect(await readBalance(app, accounts.receivable)).toBe(gross * posted)
        expect(await readBalance(app, accounts.fees)).toBe(-fee * posted)
        const merchantTotal = (await Promise.all(accounts.merchants.map((m) => readBalance(app, m)))).reduce((sum, b) => sum + b, 0n)
        expect(merchantTotal).toBe(-(gross - fee) * posted)
        expect(violations(await checkLedger(db.pool('ledger_audit', 1)))).toEqual([])
      })
    }

    it(`${name} rejects a second journal with the same external ref`, async () => {
      const poster = posters.find((p) => p.name === name)
      assert(poster)
      const accounts = await accountsFor(poster, 'locked', 'dup')
      const ref = `dup-${poster.name}`
      await poster.post({ externalRef: ref, entries: capture(accounts, 2, 2000n, 50n) })
      await expect(poster.post({ externalRef: ref, entries: capture(accounts, 2, 2000n, 50n) })).rejects.toBeInstanceOf(DuplicateJournalError)
    })
  }
})
