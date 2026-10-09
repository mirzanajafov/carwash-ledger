import { createTestDatabase, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkLedger, type InvariantId } from '../src/index.ts'

const MODES = ['locked', 'serializable', 'derived', 'sharded'] as const
type Mode = (typeof MODES)[number]

interface Account {
  id: bigint
}

interface Fixture {
  db: TestDatabase
  admin: pg.Pool
  audit: pg.Pool
  accounts: Map<Mode, { receivable: Account; fees: Account; merchant: Account }>
}

let fixture: Fixture

async function counts(): Promise<Record<InvariantId, number>> {
  const results = await checkLedger(fixture.audit)
  return Object.fromEntries(results.map((r) => [r.id, r.count])) as Record<InvariantId, number>
}

async function asSuperuser(...statements: string[]): Promise<void> {
  const client = await fixture.admin.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    for (const sql of statements) await client.query(sql)
    await client.query('COMMIT')
  } finally {
    client.release()
  }
}

function id(account: Account): string {
  return account.id.toString()
}

async function createAccount(app: pg.Pool, code: string, type: string, mode: Mode): Promise<Account> {
  const shards = mode === 'sharded' ? 4 : 1
  const inserted = await app.query<{ id: string }>(
    `INSERT INTO accounts (code, type, currency, balance_mode, shards)
     VALUES ($1, $2::account_type, 'EUR', $3::balance_mode, $4) RETURNING id::text`,
    [code, type, mode, shards],
  )
  const accountId = inserted.rows[0]!.id
  if (mode !== 'derived') {
    await app.query('INSERT INTO balances (account_id, shard) SELECT $1::bigint, generate_series(0, $2::int - 1)', [
      accountId,
      shards,
    ])
  }
  return { id: BigInt(accountId) }
}

async function postCapture(app: pg.Pool, ref: string, set: { receivable: Account; fees: Account; merchant: Account }, mode: Mode) {
  const client = await app.connect()
  try {
    await client.query('BEGIN')
    const journal = await client.query<{ id: string }>('INSERT INTO journals (external_ref) VALUES ($1) RETURNING id::text', [ref])
    const moves: [Account, number][] = [[set.receivable, 1000], [set.merchant, -970], [set.fees, -30]]
    for (const [account, amount] of moves) {
      await client.query('INSERT INTO entries (journal_id, account_id, amount) VALUES ($1, $2, $3)', [
        journal.rows[0]!.id,
        account.id.toString(),
        amount,
      ])
      const accountMode = account === set.merchant ? 'locked' : mode
      if (accountMode === 'derived') continue
      await client.query(
        `UPDATE balances SET amount = amount + $2
         WHERE account_id = $1 AND shard = (SELECT min(shard) FROM balances WHERE account_id = $1)`,
        [account.id.toString(), amount],
      )
    }
    await client.query('COMMIT')
  } finally {
    client.release()
  }
}

beforeEach(async () => {
  const db = await createTestDatabase()
  const app = db.pool('ledger_app', 4)
  const accounts: Fixture['accounts'] = new Map()
  for (const mode of MODES) {
    const set = {
      receivable: await createAccount(app, `${mode}:receivable`, 'asset', mode),
      fees: await createAccount(app, `${mode}:fees`, 'revenue', mode),
      merchant: await createAccount(app, `${mode}:merchant`, 'liability', 'locked'),
    }
    accounts.set(mode, set)
    for (let i = 0; i < 10; i++) await postCapture(app, `${mode}:${i}`, set, mode)
  }
  await app.query(
    `INSERT INTO balance_snapshots (account_id, amount, horizon)
     SELECT a.id, coalesce(sum(e.amount), 0), pg_snapshot_xmin(pg_current_snapshot())
     FROM accounts a LEFT JOIN entries e ON e.account_id = a.id
     WHERE a.balance_mode = 'derived'
     GROUP BY a.id`,
  )
  fixture = { db, admin: db.pool('admin', 1), audit: db.pool('ledger_audit', 1), accounts }
})

afterEach(async () => {
  await fixture.db.drop()
})

describe('the invariant checker', () => {
  it('finds nothing in a clean ledger', async () => {
    expect(await counts()).toEqual({ S1: 0, S2: 0 })
  })

  it('catches an unbalanced journal written with the triggers off', async () => {
    const { receivable, fees } = fixture.accounts.get('locked')!
    await asSuperuser(
      `WITH j AS (INSERT INTO journals (external_ref) VALUES ('forged') RETURNING id)
       INSERT INTO entries (journal_id, account_id, amount)
       SELECT j.id, a, m FROM j, (VALUES (${id(receivable)}, 100), (${id(fees)}, -99)) AS v(a, m)`,
    )
    expect((await counts()).S1).toBeGreaterThan(0)
  })

  it('catches a journal without entries', async () => {
    await asSuperuser(`INSERT INTO journals (external_ref) VALUES ('empty')`)
    expect((await counts()).S1).toBe(1)
  })

  it('catches an entry whose amount was edited', async () => {
    const { receivable } = fixture.accounts.get('locked')!
    await asSuperuser(`UPDATE entries SET amount = amount + 1 WHERE id = (SELECT min(id) FROM entries WHERE account_id = ${id(receivable)})`)
    const result = await counts()
    expect(result.S1).toBeGreaterThan(0)
    expect(result.S2).toBeGreaterThan(0)
  })

  it('catches an edit that keeps the journal balanced through the stored balances', async () => {
    const { receivable, merchant } = fixture.accounts.get('locked')!
    await asSuperuser(
      `UPDATE entries SET amount = amount + 500 WHERE id = (SELECT min(id) FROM entries WHERE account_id = ${id(receivable)})`,
      `UPDATE entries SET amount = amount - 500 WHERE id = (SELECT min(id) FROM entries WHERE account_id = ${id(merchant)})`,
    )
    expect(await counts()).toEqual({ S1: 0, S2: 2 })
  })

  for (const mode of ['locked', 'serializable', 'sharded'] as const) {
    it(`catches a ${mode} balance row that is off by one cent`, async () => {
      const { fees } = fixture.accounts.get(mode)!
      await asSuperuser(
        `UPDATE balances SET amount = amount + 1 WHERE account_id = ${id(fees)} AND shard = (SELECT min(shard) FROM balances WHERE account_id = ${id(fees)})`,
      )
      expect(await counts()).toEqual({ S1: 0, S2: 1 })
    })
  }

  it('catches a missing shard row', async () => {
    const { receivable } = fixture.accounts.get('sharded')!
    await asSuperuser(`DELETE FROM balances WHERE account_id = ${id(receivable)} AND shard = 3`)
    expect((await counts()).S2).toBe(1)
  })

  it('catches a derived snapshot that is off by one cent', async () => {
    const { fees } = fixture.accounts.get('derived')!
    await asSuperuser(`UPDATE balance_snapshots SET amount = amount - 1 WHERE account_id = ${id(fees)}`)
    expect(await counts()).toEqual({ S1: 0, S2: 1 })
  })

  it('catches balance rows on a derived account', async () => {
    const { fees } = fixture.accounts.get('derived')!
    await asSuperuser(`INSERT INTO balances (account_id, shard, amount) VALUES (${id(fees)}, 0, 0)`)
    expect((await counts()).S2).toBe(1)
  })
})
