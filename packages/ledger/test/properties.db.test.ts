import { checkLedger, violations } from '@carwash/invariants'
import fc from 'fast-check'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BALANCE_MODES, InvalidJournalError, readBalance, takeSnapshots, type Account, type BalanceMode, type EntryInput } from '../src/index.ts'
import { createModeAccounts, inParallel, openLedger, sqlState, type LedgerFixture, type ModeAccounts } from './support.ts'

let ledger: LedgerFixture
let audit: pg.Pool
let byCurrency: Map<string, Account[]>
let byMode: Map<BalanceMode, ModeAccounts>
let refCounter = 0

const amount = fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).filter((a) => a !== 0n)

const part = fc.record({ account: fc.nat(), amount })

const currencyGroup = fc.record({
  currency: fc.constantFrom('EUR', 'USD'),
  parts: fc.array(part, { minLength: 1, maxLength: 5 }),
  closer: fc.nat(),
})

const journalShape = fc.array(currencyGroup, { minLength: 1, maxLength: 2 })

type JournalShape = typeof journalShape extends fc.Arbitrary<infer T> ? T : never

function balancedEntries(shape: JournalShape): EntryInput[] {
  const entries: EntryInput[] = []
  for (const group of shape) {
    const accounts = byCurrency.get(group.currency)!
    const pick = (n: number) => accounts[n % accounts.length]!.id
    const groupEntries = group.parts.map((p) => ({ accountId: pick(p.account), amount: p.amount }))
    const total = groupEntries.reduce((sum, e) => sum + e.amount, 0n)
    if (total !== 0n) groupEntries.push({ accountId: pick(group.closer), amount: -total })
    entries.push(...groupEntries)
  }
  return entries
}

function nextRef(prefix: string): string {
  refCounter += 1
  return `${prefix}-${refCounter}`
}

async function expectedBalances(): Promise<Map<bigint, bigint>> {
  const result = await ledger.app.query<{ account_id: string; total: string }>(
    'SELECT account_id::text, sum(amount)::text AS total FROM entries GROUP BY account_id',
  )
  return new Map(result.rows.map((r) => [BigInt(r.account_id), BigInt(r.total)]))
}

beforeAll(async () => {
  ledger = await openLedger(16)
  audit = ledger.db.pool('ledger_audit', 2)
  byCurrency = new Map()
  for (const currency of ['EUR', 'USD']) {
    const accounts: Account[] = []
    for (const mode of BALANCE_MODES) {
      const set = await createModeAccounts(ledger.app, mode, { currency, merchants: 2, prefix: 'prop:' })
      accounts.push(set.receivable, set.fees, ...set.merchants)
    }
    byCurrency.set(currency, accounts)
  }
  byMode = new Map()
  for (const mode of BALANCE_MODES) {
    byMode.set(mode, await createModeAccounts(ledger.app, mode, { merchants: 3, prefix: 'diff:' }))
  }
})

afterAll(async () => {
  await ledger.close()
})

describe('ledger properties', () => {
  it('random balanced journals keep every invariant and every balance mode exact', async () => {
    const model = new Map<bigint, bigint>()
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ shape: journalShape, poster: fc.nat({ max: 3 }), snapshot: fc.boolean() }), {
          minLength: 1,
          maxLength: 12,
        }),
        async (journals) => {
          for (const journal of journals) {
            const entries = balancedEntries(journal.shape)
            await ledger.posters[journal.poster]!.post({ externalRef: nextRef('balanced'), entries })
            for (const e of entries) model.set(e.accountId, (model.get(e.accountId) ?? 0n) + e.amount)
            if (journal.snapshot) await takeSnapshots(ledger.app)
          }
          for (const accounts of byCurrency.values()) {
            for (const account of accounts) {
              expect(await readBalance(ledger.app, account)).toBe(model.get(account.id) ?? 0n)
            }
          }
          expect(violations(await checkLedger(audit))).toEqual([])
        },
      ),
      { numRuns: 30 },
    )
  })

  it('unbalanced journals are rejected by the code and by the database', async () => {
    await fc.assert(
      fc.asyncProperty(journalShape, amount, fc.nat(), async (shape, skew, at) => {
        const entries = balancedEntries(shape)
        const index = at % entries.length
        entries[index] = { ...entries[index]!, amount: entries[index]!.amount + skew }
        fc.pre(entries.every((e) => e.amount !== 0n))

        const before = await expectedBalances()
        await expect(ledger.poster.post({ externalRef: nextRef('unbalanced'), entries })).rejects.toBeInstanceOf(InvalidJournalError)

        const client = await ledger.app.connect()
        let state: string | undefined
        try {
          state = await sqlState(
            (async () => {
              await client.query('BEGIN')
              const journal = await client.query<{ id: string }>('INSERT INTO journals (external_ref) VALUES ($1) RETURNING id::text', [
                nextRef('raw-unbalanced'),
              ])
              await client.query(
                `INSERT INTO entries (journal_id, account_id, amount)
                 SELECT $1::bigint, t.a, t.m FROM unnest($2::bigint[], $3::bigint[]) AS t(a, m)`,
                [journal.rows[0]!.id, entries.map((e) => e.accountId.toString()), entries.map((e) => e.amount.toString())],
              )
              await client.query('COMMIT')
            })(),
          )
        } finally {
          await client.query('ROLLBACK').catch(() => undefined)
          client.release()
        }
        expect(state).toBe('LG002')
        expect(await expectedBalances()).toEqual(before)
      }),
      { numRuns: 40 },
    )
  })

  it('the four balance modes agree under concurrent posting with snapshots in between', async () => {
    const roles = (m: ModeAccounts) => [m.receivable, m.fees, ...m.merchants]
    const template = fc.array(fc.record({ from: fc.nat(), to: fc.nat(), amount: fc.bigInt({ min: 1n, max: 100_000n }) }), {
      minLength: 1,
      maxLength: 3,
    })
    await fc.assert(
      fc.asyncProperty(fc.array(template, { minLength: 5, maxLength: 40 }), async (templates) => {
        const work = templates.flatMap((moves, t) => BALANCE_MODES.map((mode) => ({ mode, moves, ref: nextRef(`diff-${t}-${mode}`) })))
        let snapshotting = true
        const snapshots = (async () => {
          while (snapshotting) {
            await takeSnapshots(ledger.app)
            await new Promise((resolve) => setTimeout(resolve, 2))
          }
        })()
        await inParallel(
          work.sort(() => Math.random() - 0.5),
          12,
          async ({ mode, moves, ref }) => {
            const accounts = roles(byMode.get(mode)!)
            const entries: EntryInput[] = []
            for (const move of moves) {
              const from = accounts[move.from % accounts.length]!.id
              const to = accounts[(move.from + 1 + (move.to % (accounts.length - 1))) % accounts.length]!.id
              entries.push({ accountId: from, amount: -move.amount }, { accountId: to, amount: move.amount })
            }
            await ledger.poster.post({ externalRef: ref, entries })
          },
        )
        snapshotting = false
        await snapshots

        const perMode = await Promise.all(BALANCE_MODES.map(async (mode) => Promise.all(roles(byMode.get(mode)!).map((a) => readBalance(ledger.app, a)))))
        for (const balances of perMode.slice(1)) expect(balances).toEqual(perMode[0])
        expect(violations(await checkLedger(audit))).toEqual([])
      }),
      { numRuns: 10 },
    )
  })
})
