import { checkout } from '@carwash/pg'
import type pg from 'pg'
import { DERIVED_BALANCE, SELECT_JOURNAL_ENTRIES, STORED_BALANCE, TAKE_SNAPSHOTS } from './sql.ts'
import { InvalidJournalError } from './errors.ts'
import { failpoint } from './failpoints.ts'
import type { Account, JournalInput, Queryable } from './types.ts'

export const SNAPSHOT_LOCK_KEY = 7_240_001

export async function readBalance(db: Queryable, account: Account): Promise<bigint> {
  const sql = account.balanceMode === 'derived' ? DERIVED_BALANCE : STORED_BALANCE
  const result = await db.query<{ amount: string }>(sql, [account.id.toString()])
  return BigInt(result.rows[0]!.amount)
}

export interface SnapshotRun {
  horizon: string
  accounts: number
}

export async function takeSnapshots(pool: pg.Pool): Promise<SnapshotRun | null> {
  const lease = await checkout(pool)
  const { client } = lease
  let broken = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [
      SNAPSHOT_LOCK_KEY,
    ])
    if (!lock.rows[0]!.locked) {
      await client.query('ROLLBACK')
      return null
    }
    const horizon = await client.query<{ horizon: string }>(
      'SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon',
    )
    const value = horizon.rows[0]!.horizon
    const written = await client.query(TAKE_SNAPSHOTS, [value])
    failpoint('snapshot.before_commit')
    await client.query('COMMIT')
    return { horizon: value, accounts: written.rowCount ?? 0 }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      broken = true
    })
    throw error
  } finally {
    lease.release(broken)
  }
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
