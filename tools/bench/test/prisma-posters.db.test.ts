import { createPrisma, type PrismaClient } from '@carwash/db'
import { checkLedger, violations } from '@carwash/invariants'
import {
  AccountRegistry,
  BALANCE_MODES,
  createAccount,
  DuplicateJournalError,
  PgCtePoster,
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
import fc from 'fast-check'
import type pg from 'pg'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { PrismaApiPoster, PrismaCtePoster, PrismaSqlPoster } from '../src/prisma-posters.ts'

const PATIENT_RETRY = { maxAttempts: 40, baseDelayMs: 2, maxDelayMs: 100 }

let db: TestDatabase
let app: pg.Pool
let audit: pg.Pool
let prisma: PrismaClient
let posters: Poster[]

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  db = await createTestDatabase()
  cleanup.defer(() => db.drop())
  app = db.pool('ledger_app', 16)
  audit = db.pool('ledger_audit', 2)
  prisma = createPrisma(db.url('ledger_app'), 16)
  cleanup.defer(() => prisma.$disconnect())
  const registry = new AccountRegistry(pgAccountLoader(app))
  posters = [PrismaApiPoster, PrismaSqlPoster, PrismaCtePoster].map((Variant) => new Variant(prisma, registry, PATIENT_RETRY))
  posters.push(new PgCtePoster(app, registry, PATIENT_RETRY))
})

afterAll(() => cleanup.disposeAsync())

interface Accounts {
  receivable: Account
  fees: Account
  merchants: Account[]
}

async function accountsFor(tag: string, mode: BalanceMode, currency = 'EUR'): Promise<Accounts> {
  const spec = { currency, balanceMode: mode, shards: 8 }
  const code = (name: string) => `${tag}:${mode}:${currency}:${name}`
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

function inTwoParts(entries: readonly EntryInput[]): EntryInput[] {
  return entries.flatMap((entry) => {
    const first = entry.amount / 2n
    return first === 0n
      ? [entry]
      : [
          { ...entry, amount: first },
          { ...entry, amount: entry.amount - first },
        ]
  })
}

function posterNamed(name: string): Poster {
  const poster = posters.find((p) => p.name === name)
  assert(poster)
  return poster
}

async function postAll(poster: Poster, refs: readonly string[], entriesFor: (ref: string) => EntryInput[]): Promise<string[]> {
  const queue = refs.values()
  const gaveUp: string[] = []
  const post = async (ref: string) => {
    try {
      await poster.post({ externalRef: ref, entries: entriesFor(ref) })
    } catch (error) {
      if (!(error instanceof RetriesExhaustedError)) throw error
      gaveUp.push(ref)
    }
  }
  const workers = await Promise.allSettled(
    Array.from({ length: 16 }, async () => {
      for (const ref of queue) await post(ref)
    }),
  )
  const failed = workers.find((worker) => worker.status === 'rejected')
  if (failed) throw failed.reason
  return gaveUp
}

describe('the Prisma posters that E2 compares with pg-cte', () => {
  const journals = 120
  const gross = 1500n
  const fee = 40n

  for (const name of ['prisma-api', 'prisma-sql', 'prisma-cte']) {
    for (const mode of BALANCE_MODES) {
      it(`${name} keeps ${mode} balances exact under concurrent captures`, async () => {
        const accounts = await accountsFor(name, mode)
        const refs = Array.from({ length: journals }, (_, i) => `${name}:${mode}:${i}`)
        const gaveUp = await postAll(posterNamed(name), refs, (ref) => capture(accounts, Number(ref.split(':').at(-1)), gross, fee))
        if (mode !== 'serializable') expect(gaveUp).toEqual([])
        if (mode === 'derived') await takeSnapshots(app)
        const posted = BigInt(journals - gaveUp.length)
        expect(await readBalance(app, accounts.receivable)).toBe(gross * posted)
        expect(await readBalance(app, accounts.fees)).toBe(-fee * posted)
        const merchantTotal = (await Promise.all(accounts.merchants.map((m) => readBalance(app, m)))).reduce((sum, b) => sum + b, 0n)
        expect(merchantTotal).toBe(-(gross - fee) * posted)
        expect((await app.query('SELECT 1 FROM journals WHERE external_ref = ANY($1)', [gaveUp])).rowCount).toBe(0)
        expect(violations(await checkLedger(audit))).toEqual([])
      })
    }

    it(`${name} rejects a second journal with the same external ref`, async () => {
      const accounts = await accountsFor(`${name}-dup`, 'locked')
      const poster = posterNamed(name)
      await poster.post({ externalRef: `dup-${name}`, entries: capture(accounts, 2, 2000n, 50n) })
      await expect(poster.post({ externalRef: `dup-${name}`, entries: capture(accounts, 2, 2000n, 50n) })).rejects.toBeInstanceOf(DuplicateJournalError)
    })
  }

  it('leaves the same books as pg-cte when all four post to the same accounts, in one currency or two, with split entries', async () => {
    const books = new Map<string, Accounts>()
    for (const mode of BALANCE_MODES) {
      for (const currency of ['EUR', 'USD']) books.set(`${mode}:${currency}`, await accountsFor('mixed', mode, currency))
    }
    const model = new Map<bigint, bigint>()
    let next = 0
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            poster: fc.nat({ max: posters.length - 1 }),
            mode: fc.constantFrom(...BALANCE_MODES),
            currencies: fc.constantFrom(['EUR'], ['USD'], ['EUR', 'USD']),
            merchant: fc.nat({ max: 3 }),
            gross: fc.bigInt({ min: 100n, max: 1_000_000n }),
            split: fc.boolean(),
            snapshot: fc.boolean(),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (journals) => {
          for (const journal of journals) {
            const poster = posters[journal.poster]
            assert(poster)
            const captures = journal.currencies.flatMap((currency) => {
              const accounts = books.get(`${journal.mode}:${currency}`)
              assert(accounts)
              return capture(accounts, journal.merchant, journal.gross, journal.gross / 50n)
            })
            const entries = journal.split ? inTwoParts(captures) : captures
            await poster.post({ externalRef: `mixed:${next++}`, entries })
            for (const e of entries) model.set(e.accountId, (model.get(e.accountId) ?? 0n) + e.amount)
            if (journal.snapshot) await takeSnapshots(app)
          }
          for (const accounts of books.values()) {
            for (const account of [accounts.receivable, accounts.fees, ...accounts.merchants]) {
              expect(await readBalance(app, account)).toBe(model.get(account.id) ?? 0n)
            }
          }
          expect(violations(await checkLedger(audit))).toEqual([])
        },
      ),
      { numRuns: 15 },
    )
  })
})
