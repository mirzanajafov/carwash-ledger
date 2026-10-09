import type pg from 'pg'
import type { InvariantResult } from './types.ts'

const EXAMPLES = 5

interface Check {
  sql: string
}

async function collect(client: pg.ClientBase, checks: readonly Check[]): Promise<{ count: number; examples: string[] }> {
  let count = 0
  const examples: string[] = []
  for (const check of checks) {
    const result = await client.query<{ detail: string; total: string }>(
      `SELECT detail, count(*) OVER () AS total FROM (${check.sql}) AS v LIMIT ${EXAMPLES}`,
    )
    if (result.rows.length === 0) continue
    count += Number(result.rows[0]!.total)
    for (const row of result.rows) if (examples.length < EXAMPLES) examples.push(row.detail)
  }
  return { count, examples }
}

const JOURNALS_BALANCE: readonly Check[] = [
  {
    sql: `
      SELECT 'journal ' || e.journal_id || ' is off by ' || sum(e.amount) || ' ' || a.currency AS detail
      FROM entries e
      JOIN accounts a ON a.id = e.account_id
      GROUP BY e.journal_id, a.currency
      HAVING sum(e.amount) <> 0`,
  },
  {
    sql: `
      SELECT 'journal ' || j.id || ' has ' || count(e.id) || ' entries' AS detail
      FROM journals j
      LEFT JOIN entries e ON e.journal_id = j.id
      GROUP BY j.id
      HAVING count(e.id) < 2`,
  },
  {
    sql: `
      SELECT 'entry ' || id || ' has amount zero' AS detail
      FROM entries
      WHERE amount = 0`,
  },
  {
    sql: `
      SELECT 'all ' || a.currency || ' entries sum to ' || sum(e.amount) AS detail
      FROM entries e
      JOIN accounts a ON a.id = e.account_id
      GROUP BY a.currency
      HAVING sum(e.amount) <> 0`,
  },
]

const STORED_BALANCES: readonly Check[] = [
  {
    sql: `
      WITH entry_totals AS (
        SELECT account_id, sum(amount) AS total FROM entries GROUP BY account_id
      ), stored AS (
        SELECT account_id, sum(amount) AS total, count(*) AS rows FROM balances GROUP BY account_id
      )
      SELECT 'account ' || a.code || ' (' || a.balance_mode || ') stores ' || coalesce(s.total, 0)
             || ' in ' || coalesce(s.rows, 0) || ' of ' || a.shards || ' rows, its entries sum to '
             || coalesce(t.total, 0) AS detail
      FROM accounts a
      LEFT JOIN stored s ON s.account_id = a.id
      LEFT JOIN entry_totals t ON t.account_id = a.id
      WHERE a.balance_mode <> 'derived'
        AND (coalesce(s.total, 0) <> coalesce(t.total, 0) OR coalesce(s.rows, 0) <> a.shards)`,
  },
  {
    sql: `
      SELECT 'account ' || a.code || ' snapshot holds ' || s.amount || ' at horizon ' || s.horizon
             || ', its entries below the horizon sum to ' || coalesce(t.total, 0) AS detail
      FROM accounts a
      JOIN balance_snapshots s ON s.account_id = a.id
      LEFT JOIN LATERAL (
        SELECT sum(e.amount) AS total
        FROM entries e
        WHERE e.account_id = a.id AND e.created_xid < s.horizon
      ) t ON true
      WHERE s.amount <> coalesce(t.total, 0)`,
  },
  {
    sql: `
      SELECT 'account ' || a.code || ' is derived but has balance rows' AS detail
      FROM accounts a
      WHERE a.balance_mode = 'derived' AND EXISTS (SELECT 1 FROM balances b WHERE b.account_id = a.id)`,
  },
  {
    sql: `
      SELECT 'account ' || a.code || ' (' || a.balance_mode || ') has a snapshot' AS detail
      FROM accounts a
      JOIN balance_snapshots s ON s.account_id = a.id
      WHERE a.balance_mode <> 'derived'`,
  },
]

export async function checkLedgerIn(client: pg.ClientBase): Promise<InvariantResult[]> {
  const s1 = await collect(client, JOURNALS_BALANCE)
  const s2 = await collect(client, STORED_BALANCES)
  return [
    { id: 'S1', description: 'every journal sums to zero per currency and has at least two entries', ...s1 },
    { id: 'S2', description: 'every stored balance equals the sum of its entries', ...s2 },
  ]
}

export async function checkLedger(pool: pg.Pool): Promise<InvariantResult[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const results = await checkLedgerIn(client)
    await client.query('COMMIT')
    return results
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
