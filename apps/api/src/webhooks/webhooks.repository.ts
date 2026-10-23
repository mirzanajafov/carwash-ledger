import { deleteInBatches, type Queryable } from '@carwash/pg'

export type WebhookOutcome = 'applied' | 'already' | 'anomaly' | 'not_at_psp' | 'unmatched' | 'reported'

export interface WebhookEvent {
  id: string
  type: string
  attemptId: string | null
  outcome: WebhookOutcome
  payload: unknown
}

export async function webhookOutcome(db: Queryable, id: string): Promise<WebhookOutcome | undefined> {
  const { rows } = await db.query<{ outcome: WebhookOutcome }>('SELECT outcome FROM webhook_events WHERE id = $1', [id])
  return rows[0]?.outcome
}

export async function recordWebhook(db: Queryable, event: WebhookEvent): Promise<void> {
  await db.query(`INSERT INTO webhook_events (id, type, attempt_id, outcome, payload) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`, [
    event.id,
    event.type,
    event.attemptId,
    event.outcome,
    JSON.stringify(event.payload),
  ])
}

export async function unmatchedWebhooks(db: Queryable, reportAfterSeconds: number, limit: number) {
  const { rows } = await db.query<{ id: string; key: string; overdue: boolean }>(
    `SELECT id, payload->'data'->'object'->>'idempotency_key' AS key, received_at <= now() - make_interval(secs => $1) AS overdue
     FROM webhook_events WHERE outcome = 'unmatched' AND checked_at <= now() - interval '30 seconds'
     ORDER BY received_at LIMIT $2`,
    [reportAfterSeconds, limit],
  )
  return rows
}

export async function markWebhookChecked(db: Queryable, id: string, outcome: WebhookOutcome, attemptId: string | null): Promise<void> {
  await db.query(`UPDATE webhook_events SET outcome = $2, attempt_id = $3, checks = checks + 1, checked_at = now() WHERE id = $1`, [id, outcome, attemptId])
}

export function pruneWebhookEvents(db: Queryable, retentionDays: number, batch = 1000): Promise<number> {
  return deleteInBatches(
    db,
    `DELETE FROM webhook_events WHERE id IN (
       SELECT id FROM webhook_events WHERE received_at <= now() - make_interval(days => $1) LIMIT $2)`,
    [retentionDays],
    batch,
  )
}
