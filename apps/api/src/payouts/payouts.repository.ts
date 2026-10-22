import { firstRow, type Queryable } from '@carwash/pg'

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

export async function loadPayout(db: Queryable, id: string, lock = false): Promise<PayoutRecord | undefined> {
  const { rows } = await db.query<PayoutRecord>(`${PAYOUT}${lock ? ' FOR UPDATE OF o' : ''}`, [id])
  return rows[0]
}

export async function lockBalances(db: Queryable, accountIds: readonly string[]): Promise<Map<string, bigint>> {
  const { rows } = await db.query<{ account_id: string; amount: string }>(
    `SELECT b.account_id::text, b.amount::text FROM balances b WHERE b.account_id = ANY($1::bigint[]) ORDER BY b.account_id, b.shard FOR UPDATE`,
    [accountIds],
  )
  return new Map(rows.map((row) => [row.account_id, BigInt(row.amount)]))
}

export async function insertPayout(db: Queryable, merchantId: string, amount: bigint, currency: string): Promise<string> {
  return firstRow(
    await db.query<{ id: string }>('INSERT INTO payouts (merchant_id, amount, currency) VALUES ($1, $2, $3) RETURNING id', [merchantId, amount, currency]),
  ).id
}

export async function setPayoutJournal(db: Queryable, id: string, journalId: bigint): Promise<void> {
  await db.query('UPDATE payouts SET journal_id = $2 WHERE id = $1', [id, journalId])
}

export async function adjustPayout(db: Queryable, id: string, amount: bigint, journalId: bigint): Promise<void> {
  await db.query(`UPDATE payouts SET amount = $2, adjustment_journal_id = $3 WHERE id = $1 AND status = 'pending'`, [id, amount, journalId])
}

export async function succeedPayout(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE payouts SET status = 'succeeded', resolved_at = now() WHERE id = $1 AND status = 'pending'`, [id])
}

export async function failPayout(db: Queryable, id: string, reason: string, reversalId: bigint): Promise<void> {
  await db.query(
    `UPDATE payouts SET status = 'failed', failure_reason = $2, reversal_journal_id = $3, resolved_at = now() WHERE id = $1 AND status = 'pending'`,
    [id, reason, reversalId],
  )
}
