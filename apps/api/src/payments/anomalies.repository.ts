import type { Queryable } from '@carwash/pg'
import type { AttemptId } from '../ids.ts'
import type { AttemptKind } from '../psp/answers.ts'
import type { AttemptStatus } from './attempt.ts'

export interface AnomalyAttempt {
  id: string
  kind: AttemptKind
  status: AttemptStatus
  amount: string
  currency: string
}

export type AnomalyKind = 'answer_mismatch' | 'unexpected_answer' | 'answer_changed' | 'refund_declined' | 'unmatched_webhook'

export interface AnomalyRow {
  id: string
  kind: AnomalyKind
  created_at: Date
  details: { problems?: string[]; answer?: { amount?: unknown } } | null
  resolution: string | null
  resolved_at: Date | null
  resolver: string | null
  attempt: AnomalyAttempt | null
  payment_id: string | null
  refund_id: string | null
  payout_id: string | null
  merchant: string | null
}

const SELECT = `
  SELECT an.id::text, an.kind, an.created_at, an.details, an.resolution, an.resolved_at, rc.name AS resolver,
         CASE WHEN a.id IS NULL THEN NULL
              ELSE json_build_object('id', a.id, 'kind', a.kind, 'status', a.status, 'amount', a.amount::text, 'currency', a.currency) END AS attempt,
         a.payment_id::text, a.refund_id::text, a.payout_id::text, m.code AS merchant
  FROM anomalies an
  LEFT JOIN attempts a ON a.id = an.attempt_id
  LEFT JOIN payments p ON p.id = a.payment_id
  LEFT JOIN payouts po ON po.id = a.payout_id
  LEFT JOIN merchants m ON m.id = coalesce(p.merchant_id, po.merchant_id)
  LEFT JOIN api_clients rc ON rc.id = an.resolved_by`

export async function recordAnomaly(db: Queryable, attemptId: AttemptId | null, kind: AnomalyKind, details: unknown): Promise<void> {
  await db.query('INSERT INTO anomalies (attempt_id, kind, details) VALUES ($1, $2, $3) ON CONFLICT (attempt_id, kind) DO NOTHING', [
    attemptId,
    kind,
    JSON.stringify(details),
  ])
}

export async function listAnomalies(db: Queryable, open: boolean, limit: number): Promise<AnomalyRow[]> {
  const { rows } = await db.query<AnomalyRow>(`${SELECT} WHERE (an.resolved_at IS NULL) = $1 ORDER BY an.id DESC LIMIT $2`, [open, limit])
  return rows
}

export async function findAnomaly(db: Queryable, id: number): Promise<AnomalyRow | undefined> {
  const { rows } = await db.query<AnomalyRow>(`${SELECT} WHERE an.id = $1`, [id])
  return rows[0]
}

export async function resolveAnomaly(db: Queryable, id: number, resolution: 'accepted' | 'disputed', clientId: string): Promise<boolean> {
  const resolved = await db.query(`UPDATE anomalies SET resolution = $3, resolved_at = now(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL`, [
    id,
    clientId,
    resolution,
  ])
  return resolved.rowCount === 1
}
