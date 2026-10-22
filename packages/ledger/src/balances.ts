import { failpoint } from '@carwash/failpoints'
import { firstRow, withTransaction, type Queryable } from '@carwash/pg'
import type pg from 'pg'
import { DERIVED_BALANCE, SELECT_JOURNAL_ENTRIES, STORED_BALANCE, TAKE_SNAPSHOTS } from './sql.ts'
import { InvalidJournalError } from './errors.ts'
import type { Account, JournalInput } from './types.ts'

export const SNAPSHOT_LOCK_KEY = 7_240_001

export async function readBalance(db: Queryable, account: Account): Promise<bigint> {
  const sql = account.balanceMode === 'derived' ? DERIVED_BALANCE : STORED_BALANCE
  return BigInt(firstRow(await db.query<{ amount: string }>(sql, [account.id.toString()])).amount)
}

export interface SnapshotRun {
  horizon: string
  accounts: number
}

export function takeSnapshots(pool: pg.Pool): Promise<SnapshotRun | null> {
  return withTransaction(
    pool,
    async (client) => {
      const { locked } = firstRow(await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [SNAPSHOT_LOCK_KEY]))
      if (!locked) return null
      const value = firstRow(await client.query<{ horizon: string }>('SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon')).horizon
      const written = await client.query(TAKE_SNAPSHOTS, [value])
      failpoint('snapshot.before_commit')
      return { horizon: value, accounts: written.rowCount ?? 0 }
    },
    { isolation: 'repeatable read' },
  )
}

export async function reversalOf(db: Queryable, journalId: bigint, externalRef: string): Promise<JournalInput> {
  const result = await db.query<{ account_id: string; amount: string }>(SELECT_JOURNAL_ENTRIES, [journalId.toString()])
  if (result.rows.length === 0) throw new InvalidJournalError(`journal ${journalId} not found`)
  return {
    externalRef,
    reversesId: journalId,
    entries: result.rows.map((row) => ({ accountId: BigInt(row.account_id), amount: -BigInt(row.amount) })),
  }
}

export interface AccountBalance {
  code: string
  type: string
  currency: string
  amount: bigint
}

const ALL_BALANCES = `
SELECT a.code, a.type::text, a.currency,
       (CASE WHEN a.balance_mode = 'derived'
             THEN coalesce(s.amount, 0) + coalesce((
                    SELECT sum(e.amount) FROM entries e
                    WHERE e.account_id = a.id AND e.created_xid >= coalesce(s.horizon, '0'::xid8)
                  ), 0)
             ELSE coalesce((SELECT sum(b.amount) FROM balances b WHERE b.account_id = a.id), 0)
        END)::text AS amount
FROM accounts a
LEFT JOIN balance_snapshots s ON s.account_id = a.id
ORDER BY a.id`

export async function readAllBalances(db: Queryable): Promise<AccountBalance[]> {
  const { rows } = await db.query<{ code: string; type: string; currency: string; amount: string }>(ALL_BALANCES)
  return rows.map((row) => ({ ...row, amount: BigInt(row.amount) }))
}
