import { firstRow, type Queryable, type Transaction } from '@carwash/pg'
import { attemptId, paymentId, payoutId, refundId, type AttemptId, type PaymentId, type PayoutId, type RefundId } from '../ids.ts'
import type { AttemptKind, PspAnswer } from '../psp/answers.ts'
import type { Attempt, AttemptStatus, CardAttemptKind } from './attempt.ts'

export type NewAttempt = { amount: bigint; currency: string } & (
  { kind: CardAttemptKind; paymentId: PaymentId } | { kind: 'refund'; paymentId: PaymentId; refundId: RefundId } | { kind: 'payout'; payoutId: PayoutId }
)

export type AttemptOwner = { paymentId: PaymentId } | { refundId: RefundId } | { payoutId: PayoutId }

interface AttemptRow {
  id: string
  kind: AttemptKind
  status: AttemptStatus
  payment_id: string | null
  refund_id: string | null
  payout_id: string | null
  amount: string
  currency: string
  psp_operation_id: string | null
  decline_reason: string | null
}

const COLUMNS = `id, kind::text, status::text, payment_id, refund_id, payout_id, amount::text, currency, psp_operation_id, decline_reason`

function toAttempt(row: AttemptRow): Attempt {
  const fields = {
    id: attemptId(row.id),
    status: row.status,
    amount: BigInt(row.amount),
    currency: row.currency,
    pspOperationId: row.psp_operation_id,
    declineReason: row.decline_reason,
  }
  if (row.kind === 'payout') {
    if (row.payout_id === null) throw new Error(`payout attempt ${row.id} has no payout`)
    return { ...fields, kind: row.kind, payoutId: payoutId(row.payout_id) }
  }
  if (row.payment_id === null) throw new Error(`${row.kind} attempt ${row.id} has no payment`)
  if (row.kind !== 'refund') return { ...fields, kind: row.kind, paymentId: paymentId(row.payment_id) }
  if (row.refund_id === null) throw new Error(`refund attempt ${row.id} has no refund`)
  return { ...fields, kind: row.kind, paymentId: paymentId(row.payment_id), refundId: refundId(row.refund_id) }
}

function ownerColumn(owner: AttemptOwner): [string, string] {
  if ('paymentId' in owner) return ['payment_id', owner.paymentId]
  if ('refundId' in owner) return ['refund_id', owner.refundId]
  return ['payout_id', owner.payoutId]
}

export async function findAttempt(db: Queryable, id: string): Promise<Attempt | undefined> {
  const [row] = (await db.query<AttemptRow>(`SELECT ${COLUMNS} FROM attempts WHERE id = $1`, [id])).rows
  return row && toAttempt(row)
}

export async function loadAttempt(db: Queryable, id: AttemptId): Promise<Attempt> {
  return toAttempt(firstRow(await db.query<AttemptRow>(`SELECT ${COLUMNS} FROM attempts WHERE id = $1`, [id])))
}

export async function pendingAttempt(db: Queryable, owner: AttemptOwner, kinds: readonly AttemptKind[]): Promise<Attempt | undefined> {
  const [column, id] = ownerColumn(owner)
  const [row] = (
    await db.query<AttemptRow>(
      `SELECT ${COLUMNS} FROM attempts WHERE ${column} = $1 AND kind = ANY($2::attempt_kind[]) AND status = 'pending' ORDER BY created_at LIMIT 1`,
      [id, kinds],
    )
  ).rows
  return row && toAttempt(row)
}

export async function attemptsToRecover(db: Queryable, olderThanSeconds: number, limit: number): Promise<Attempt[]> {
  const { rows } = await db.query<AttemptRow>(
    `SELECT ${COLUMNS} FROM attempts
     WHERE status = 'pending' AND created_at <= now() - make_interval(secs => $1)
       AND NOT EXISTS (SELECT 1 FROM anomalies WHERE anomalies.attempt_id = attempts.id)
     ORDER BY created_at LIMIT $2`,
    [olderThanSeconds, limit],
  )
  return rows.map(toAttempt)
}

export async function insertAttempt(client: Transaction, attempt: NewAttempt): Promise<void> {
  await client.query(`INSERT INTO attempts (kind, payment_id, refund_id, payout_id, amount, currency) VALUES ($1::attempt_kind, $2, $3, $4, $5, $6)`, [
    attempt.kind,
    'paymentId' in attempt ? attempt.paymentId : null,
    'refundId' in attempt ? attempt.refundId : null,
    'payoutId' in attempt ? attempt.payoutId : null,
    attempt.amount,
    attempt.currency,
  ])
}

export async function resolveAttempt(client: Transaction, id: AttemptId, answer: PspAnswer): Promise<boolean> {
  const updated = await client.query(
    `UPDATE attempts SET status = $2::attempt_status, psp_operation_id = $3, decline_reason = $4, resolved_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [id, answer.status, answer.operationId, answer.reason],
  )
  return updated.rowCount === 1
}

export async function attemptOutcome(db: Queryable, id: AttemptId): Promise<{ status: AttemptStatus; pspOperationId: string | null }> {
  const row = firstRow(
    await db.query<{ status: AttemptStatus; psp_operation_id: string | null }>('SELECT status::text, psp_operation_id FROM attempts WHERE id = $1', [id]),
  )
  return { status: row.status, pspOperationId: row.psp_operation_id }
}

export async function setAttemptAmount(client: Transaction, id: AttemptId, amount: bigint): Promise<boolean> {
  const moved = await client.query(`UPDATE attempts SET amount = $2 WHERE id = $1 AND status = 'pending'`, [id, amount])
  return moved.rowCount === 1
}
