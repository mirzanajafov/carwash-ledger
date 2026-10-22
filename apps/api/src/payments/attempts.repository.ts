import { firstRow, type Queryable } from '@carwash/pg'
import type { AttemptKind } from '../psp/answers.ts'

export interface AttemptRecord {
  id: string
  kind: AttemptKind
  status: 'pending' | 'succeeded' | 'declined'
  payment_id: string | null
  refund_id: string | null
  payout_id: string | null
  amount: string
  currency: string
  psp_operation_id: string | null
  decline_reason: string | null
}

export interface NewAttempt {
  kind: AttemptKind
  paymentId?: string
  refundId?: string
  payoutId?: string
  amount: number | bigint | string
  currency: string
}

export interface AttemptOutcome {
  status: 'succeeded' | 'declined'
  operationId: string | null
  reason: string | null
}

const COLUMNS = `id, kind::text, status::text, payment_id, refund_id, payout_id, amount::text, currency, psp_operation_id, decline_reason`

export async function loadAttempt(db: Queryable, id: string): Promise<AttemptRecord | undefined> {
  const { rows } = await db.query<AttemptRecord>(`SELECT ${COLUMNS} FROM attempts WHERE id = $1`, [id])
  return rows[0]
}

export async function pendingAttempt(db: Queryable, column: 'payment_id' | 'refund_id' | 'payout_id', id: string, kinds: readonly AttemptKind[]) {
  const { rows } = await db.query<AttemptRecord>(
    `SELECT ${COLUMNS} FROM attempts WHERE ${column} = $1 AND kind = ANY($2::attempt_kind[]) AND status = 'pending' ORDER BY created_at LIMIT 1`,
    [id, kinds],
  )
  return rows[0]
}

export async function attemptsToRecover(db: Queryable, olderThanSeconds: number, limit: number): Promise<AttemptRecord[]> {
  const { rows } = await db.query<AttemptRecord>(
    `SELECT ${COLUMNS} FROM attempts
     WHERE status = 'pending' AND created_at <= now() - make_interval(secs => $1)
       AND NOT EXISTS (SELECT 1 FROM anomalies WHERE anomalies.attempt_id = attempts.id)
     ORDER BY created_at LIMIT $2`,
    [olderThanSeconds, limit],
  )
  return rows
}

export async function insertAttempt(db: Queryable, attempt: NewAttempt): Promise<void> {
  await db.query(`INSERT INTO attempts (kind, payment_id, refund_id, payout_id, amount, currency) VALUES ($1::attempt_kind, $2, $3, $4, $5, $6)`, [
    attempt.kind,
    attempt.paymentId ?? null,
    attempt.refundId ?? null,
    attempt.payoutId ?? null,
    attempt.amount,
    attempt.currency,
  ])
}

export async function resolveAttempt(db: Queryable, id: string, outcome: AttemptOutcome): Promise<boolean> {
  const updated = await db.query(
    `UPDATE attempts SET status = $2::attempt_status, psp_operation_id = $3, decline_reason = $4, resolved_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [id, outcome.status, outcome.operationId, outcome.reason],
  )
  return updated.rowCount === 1
}

export async function attemptOutcome(db: Queryable, id: string): Promise<{ status: string; psp_operation_id: string | null }> {
  return firstRow(
    await db.query<{ status: string; psp_operation_id: string | null }>('SELECT status::text, psp_operation_id FROM attempts WHERE id = $1', [id]),
  )
}

export async function setAttemptAmount(db: Queryable, id: string, amount: bigint): Promise<boolean> {
  const moved = await db.query(`UPDATE attempts SET amount = $2 WHERE id = $1 AND status = 'pending'`, [id, amount])
  return moved.rowCount === 1
}
