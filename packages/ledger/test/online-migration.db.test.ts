import { checkLedger, violations } from '@carwash/invariants'
import { firstRow } from '@carwash/pg'
import { applyMigration, createTestDatabase, migrationNames, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { afterEach, assert, describe, expect, it } from 'vitest'
import { AccountRegistry, backfillEntryCurrency, createAccount, PgCtePoster, pgAccountLoader } from '../src/index.ts'
import { sqlState } from './support.ts'

const STEPS = migrationNames().filter((name) => name.includes('_entries_currency_'))
const [EXPAND] = STEPS
assert(EXPAND)
const BEFORE = migrationNames()[migrationNames().indexOf(EXPAND) - 1]
assert(BEFORE)

let db: TestDatabase | undefined

afterEach(async () => {
  await db?.drop()
  db = undefined
})

interface Books {
  app: pg.Pool
  owner: pg.Pool
  post: (count: number) => Promise<void>
}

async function books(database: TestDatabase): Promise<Books> {
  const app = database.pool('ledger_app', 4)
  const owner = database.pool('ledger_owner', 2)
  const accountsIn = async (currency: string) => {
    const spec = { currency, balanceMode: 'derived' as const, shards: 1 }
    return {
      receivable: await createAccount(app, { ...spec, code: `receivable:${currency}`, type: 'asset' }),
      merchant: await createAccount(app, { ...spec, code: `merchant:${currency}`, type: 'liability' }),
      fees: await createAccount(app, { ...spec, code: `fees:${currency}`, type: 'revenue' }),
    }
  }
  const accounts = { EUR: await accountsIn('EUR'), USD: await accountsIn('USD') }
  const poster = new PgCtePoster(app, new AccountRegistry(pgAccountLoader(app)))
  let n = 0
  return {
    app,
    owner,
    async post(count) {
      for (let i = 0; i < count; i++, n++) {
        const { receivable, merchant, fees } = accounts[n % 3 === 0 ? 'USD' : 'EUR']
        const gross = 900 + (n % 5) * 600
        await poster.post({
          externalRef: `capture:${n}`,
          entries: [
            { accountId: receivable.id, amount: BigInt(gross) },
            { accountId: merchant.id, amount: BigInt(-(gross - 40)) },
            { accountId: fees.id, amount: -40n },
          ],
        })
      }
    },
  }
}

async function missing(pool: pg.Pool): Promise<number> {
  return firstRow(await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM entries WHERE currency IS NULL')).n
}

describe('the entries currency change', () => {
  it('fills the column on every insert and then guards it like the other columns', async () => {
    db = await createTestDatabase()
    const { app, owner, post } = await books(db)
    await post(6)
    const { rows } = await app.query<{ currency: string; account: string }>(
      'SELECT e.currency, a.currency AS account FROM entries e JOIN accounts a ON a.id = e.account_id',
    )
    expect(rows).toHaveLength(18)
    expect(rows.every((r) => r.currency === r.account)).toBe(true)
    expect(await sqlState(owner.query(`UPDATE entries SET currency = 'GBP' WHERE id = (SELECT min(id) FROM entries)`))).toBe('LG001')
    const client = await app.connect()
    try {
      await client.query('BEGIN')
      const journal = firstRow(await client.query<{ id: string }>(`INSERT INTO journals (external_ref) VALUES ('short') RETURNING id::text`))
      const [eur, usd] = (
        await client.query<{ id: string }>(`SELECT id::text FROM accounts WHERE code IN ('receivable:EUR', 'merchant:USD') ORDER BY code DESC`)
      ).rows
      assert(eur && usd)
      await client.query('INSERT INTO entries (journal_id, account_id, amount) VALUES ($1, $2, 100), ($1, $3, -100)', [journal.id, eur.id, usd.id])
      expect(await sqlState(client.query('COMMIT'))).toBe('LG002')
    } finally {
      client.release()
    }
    expect(violations(await checkLedger(db.pool('ledger_audit', 1)))).toEqual([])
  })

  it('expands, backfills in resumable batches and contracts on a ledger that keeps taking journals', async () => {
    db = await createTestDatabase({ through: BEFORE })
    const { app, owner, post } = await books(db)
    const ownerUrl = db.url('ledger_owner')
    await post(60)
    await applyMigration(ownerUrl, EXPAND)
    expect(await missing(app)).toBe(180)
    await post(10)
    expect(await missing(app)).toBe(180)

    const stop = new AbortController()
    let batches = 0
    const first = await backfillEntryCurrency(owner, {
      batch: 7,
      dutyCycle: 1,
      signal: stop.signal,
      onBatch: () => {
        if (++batches === 3) stop.abort()
      },
    })
    expect(first).toMatchObject({ batches: 3, updated: 21, done: false })
    expect(await missing(app)).toBe(159)
    await post(5)
    const rest = await backfillEntryCurrency(owner, { batch: 7, dutyCycle: 0.5 })
    expect(rest).toMatchObject({ updated: 159, done: true })
    expect(rest.pausedMs).toBeGreaterThan(0)
    expect(await missing(app)).toBe(0)
    expect((await backfillEntryCurrency(owner, { batch: 50, dutyCycle: 1 })).updated).toBe(0)

    for (const step of STEPS.slice(1)) await applyMigration(ownerUrl, step)
    await post(5)
    const { notnull, definition } = firstRow(
      await owner.query<{ notnull: boolean; definition: string }>(
        `SELECT (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'entries'::regclass AND attname = 'currency') AS notnull,
              pg_get_functiondef('ledger_check_balance'::regproc) AS definition`,
      ),
    )
    expect(notnull).toBe(true)
    expect(definition).not.toMatch(/JOIN accounts/)
    expect(violations(await checkLedger(db.pool('ledger_audit', 1)))).toEqual([])
  })

  it('lets the check step fill whatever the backfill left, so a small database needs no job', async () => {
    db = await createTestDatabase({ through: BEFORE })
    const { app, post } = await books(db)
    const ownerUrl = db.url('ledger_owner')
    await post(12)
    for (const step of STEPS) await applyMigration(ownerUrl, step)
    expect(await missing(app)).toBe(0)
    expect(violations(await checkLedger(db.pool('ledger_audit', 1)))).toEqual([])
  })
})
