import { firstRow, type Queryable } from '@carwash/pg'
import type pg from 'pg'

export interface PayoutRecord {
  id: string
  merchant_code: string
  merchant_account_id: string
  amount: string
  currency: string
  status: 'pending' | 'succeeded' | 'failed'
  failure_reason: string | null
  journal_id: string | null
  created_at: Date
}

const PAYOUT = `
SELECT o.id, m.code AS merchant_code, m.account_id::text AS merchant_account_id, o.amount::text, o.currency, o.status::text,
       o.failure_reason, o.journal_id::text, o.created_at
FROM payouts o JOIN merchants m ON m.id = o.merchant_id
WHERE o.id = $1`

export async function loadPayout(db: Queryable, id: string): Promise<PayoutRecord | undefined> {
  const { rows } = await db.query<PayoutRecord>(PAYOUT, [id])
  return rows[0]
}

export async function lockPayout(client: pg.ClientBase, id: string): Promise<PayoutRecord | undefined> {
  const { rows } = await client.query<PayoutRecord>(`${PAYOUT} FOR UPDATE OF o`, [id])
  return rows[0]
}

export async function lockPayoutBalances(client: pg.ClientBase, merchantAccountId: string, bankAccountId: string): Promise<bigint | undefined> {
  const { rows } = await client.query<{ account_id: string; amount: string }>(
    `SELECT b.account_id::text, b.amount::text FROM balances b WHERE b.account_id = ANY($1::bigint[]) ORDER BY b.account_id, b.shard FOR UPDATE`,
    [[merchantAccountId, bankAccountId]],
  )
  const merchant = rows.filter((row) => row.account_id === merchantAccountId)
  return merchant.length === 0 ? undefined : merchant.reduce((sum, row) => sum + BigInt(row.amount), 0n)
}

export async function insertPayout(client: pg.ClientBase, merchantId: string, amount: bigint, currency: string): Promise<string> {
  return firstRow(
    await client.query<{ id: string }>('INSERT INTO payouts (merchant_id, amount, currency) VALUES ($1, $2, $3) RETURNING id', [merchantId, amount, currency]),
  ).id
}

export async function setPayoutJournal(client: pg.ClientBase, id: string, journalId: bigint): Promise<void> {
  await client.query('UPDATE payouts SET journal_id = $2 WHERE id = $1', [id, journalId])
}

export async function recordPayoutAdjustment(client: pg.ClientBase, id: string, amount: bigint, journalId: bigint): Promise<void> {
  await client.query(`UPDATE payouts SET amount = $2, adjustment_journal_id = $3 WHERE id = $1 AND status = 'pending'`, [id, amount, journalId])
}

export async function succeedPayout(client: pg.ClientBase, id: string): Promise<void> {
  await client.query(`UPDATE payouts SET status = 'succeeded', resolved_at = now() WHERE id = $1 AND status = 'pending'`, [id])
}

export async function failPayout(client: pg.ClientBase, id: string, reason: string, reversalId: bigint): Promise<void> {
  await client.query(
    `UPDATE payouts SET status = 'failed', failure_reason = $2, reversal_journal_id = $3, resolved_at = now() WHERE id = $1 AND status = 'pending'`,
    [id, reason, reversalId],
  )
}
