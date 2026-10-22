import { firstRow, type Queryable, type Transaction } from '@carwash/pg'
import { payoutId, type PayoutId } from '../ids.ts'
import type { Payout, PayoutStatus } from './payout.ts'

interface PayoutRow {
  id: string
  merchant_code: string
  merchant_account_id: string
  amount: string
  currency: string
  status: PayoutStatus
  failure_reason: string | null
  journal_id: string | null
  created_at: Date
}

const PAYOUT = `
SELECT o.id, m.code AS merchant_code, m.account_id::text AS merchant_account_id, o.amount::text, o.currency, o.status::text,
       o.failure_reason, o.journal_id::text, o.created_at
FROM payouts o JOIN merchants m ON m.id = o.merchant_id
WHERE o.id = $1`

function toPayout(row: PayoutRow): Payout {
  if (row.journal_id === null) throw new Error(`payout ${row.id} has no journal`)
  return {
    id: payoutId(row.id),
    merchantCode: row.merchant_code,
    merchantAccountId: BigInt(row.merchant_account_id),
    amount: BigInt(row.amount),
    currency: row.currency,
    status: row.status,
    failureReason: row.failure_reason,
    journalId: BigInt(row.journal_id),
    createdAt: row.created_at,
  }
}

export async function loadPayout(db: Queryable, id: PayoutId): Promise<Payout> {
  return toPayout(firstRow(await db.query<PayoutRow>(PAYOUT, [id])))
}

export async function lockPayout(client: Transaction, id: PayoutId): Promise<Payout> {
  return toPayout(firstRow(await client.query<PayoutRow>(`${PAYOUT} FOR UPDATE OF o`, [id])))
}

export async function lockPayoutBalances(client: Transaction, merchantAccountId: bigint, bankAccountId: bigint): Promise<bigint | undefined> {
  const { rows } = await client.query<{ account_id: string; amount: string }>(
    `SELECT b.account_id::text, b.amount::text FROM balances b WHERE b.account_id = ANY($1::bigint[]) ORDER BY b.account_id, b.shard FOR UPDATE`,
    [[merchantAccountId, bankAccountId]],
  )
  const merchant = rows.filter((row) => BigInt(row.account_id) === merchantAccountId)
  return merchant.length === 0 ? undefined : merchant.reduce((sum, row) => sum + BigInt(row.amount), 0n)
}

export async function insertPayout(client: Transaction, merchantId: string, amount: bigint, currency: string): Promise<PayoutId> {
  return payoutId(
    firstRow(
      await client.query<{ id: string }>('INSERT INTO payouts (merchant_id, amount, currency) VALUES ($1, $2, $3) RETURNING id', [
        merchantId,
        amount,
        currency,
      ]),
    ).id,
  )
}

export async function setPayoutJournal(client: Transaction, id: PayoutId, journalId: bigint): Promise<void> {
  await client.query('UPDATE payouts SET journal_id = $2 WHERE id = $1', [id, journalId])
}

export async function recordPayoutAdjustment(client: Transaction, id: PayoutId, amount: bigint, journalId: bigint): Promise<void> {
  await client.query(`UPDATE payouts SET amount = $2, adjustment_journal_id = $3 WHERE id = $1 AND status = 'pending'`, [id, amount, journalId])
}

export async function succeedPayout(client: Transaction, id: PayoutId): Promise<void> {
  await client.query(`UPDATE payouts SET status = 'succeeded', resolved_at = now() WHERE id = $1 AND status = 'pending'`, [id])
}

export async function failPayout(client: Transaction, id: PayoutId, reason: string, reversalId: bigint): Promise<void> {
  await client.query(
    `UPDATE payouts SET status = 'failed', failure_reason = $2, reversal_journal_id = $3, resolved_at = now() WHERE id = $1 AND status = 'pending'`,
    [id, reason, reversalId],
  )
}
