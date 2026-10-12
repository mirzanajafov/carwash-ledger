import { Inject, Injectable, Logger } from '@nestjs/common'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { ApiError } from '../http/api-error.ts'
import { AttemptsService, pspUnavailable, recordAnomaly } from '../payments/attempts.service.ts'
import { loadAttempt } from '../payments/records.ts'
import { PspClient } from '../psp/psp.client.ts'

export type CheckOutcome = 'applied' | 'already' | 'anomaly' | 'not_at_psp' | 'unmatched'

export interface PspEvent {
  id: string
  type: string
  attemptKey: string
  payload: unknown
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function parseEvent(body: unknown): PspEvent {
  const event = body as { id?: unknown; type?: unknown; data?: { object?: { idempotency_key?: unknown } } } | null
  const id = event?.id
  const type = event?.type
  const key = event?.data?.object?.idempotency_key
  if (typeof id !== 'string' || id.length === 0 || id.length > 255 || typeof type !== 'string' || typeof key !== 'string') {
    throw new ApiError(400, 'invalid_event', 'the event needs an id, a type and data.object.idempotency_key')
  }
  return { id, type, attemptKey: key, payload: body }
}

@Injectable()
export class WebhooksService {
  readonly #db: Database
  readonly #attempts: AttemptsService
  readonly #psp: PspClient
  readonly #config: ApiConfig
  readonly #logger = new Logger('webhooks')

  constructor(db: Database, attempts: AttemptsService, psp: PspClient, @Inject(API_CONFIG) config: ApiConfig) {
    this.#db = db
    this.#attempts = attempts
    this.#psp = psp
    this.#config = config
  }

  async handle(event: PspEvent): Promise<{ received: true; outcome: string; duplicate?: true }> {
    const seen = await this.#db.pool.query<{ outcome: string }>('SELECT outcome FROM webhook_events WHERE id = $1', [event.id])
    if (seen.rows[0]) return { received: true, outcome: seen.rows[0].outcome, duplicate: true }
    const outcome = await this.check(event.attemptKey)
    await this.#db.pool.query(
      `INSERT INTO webhook_events (id, type, attempt_id, outcome, payload) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [event.id, event.type, outcome === 'unmatched' ? null : event.attemptKey, outcome, JSON.stringify(event.payload)],
    )
    return { received: true, outcome }
  }

  async check(attemptKey: string): Promise<CheckOutcome> {
    const attempt = UUID.test(attemptKey) ? await loadAttempt(this.#db.pool, attemptKey) : undefined
    if (!attempt) return 'unmatched'
    if (attempt.status !== 'pending') return 'already'
    const reply = await this.#psp.pull(attempt.id)
    if (reply.kind === 'unknown') throw pspUnavailable(reply.reason)
    if (reply.kind === 'none') return 'not_at_psp'
    try {
      return await this.#attempts.receive(await this.#attempts.callFor(attempt), reply.body)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'psp_answer_rejected') return 'anomaly'
      throw error
    }
  }

  async recheckUnmatched(reportAfterSeconds = 3600, batch = 50): Promise<number> {
    const { rows } = await this.#db.pool.query<{ id: string; key: string; overdue: boolean }>(
      `SELECT id, payload->'data'->'object'->>'idempotency_key' AS key, received_at <= now() - make_interval(secs => $1) AS overdue
       FROM webhook_events WHERE outcome = 'unmatched' AND checked_at <= now() - interval '30 seconds'
       ORDER BY received_at LIMIT $2`,
      [reportAfterSeconds, batch],
    )
    for (const row of rows) {
      let outcome: string = await this.check(row.key).catch(() => 'unmatched')
      if (outcome === 'unmatched' && row.overdue) {
        await recordAnomaly(this.#db.pool, null, 'unmatched_webhook', { event: row.id, key: row.key })
        outcome = 'reported'
      }
      await this.#db.pool.query(
        `UPDATE webhook_events SET outcome = $2, attempt_id = $3, checks = checks + 1, checked_at = now() WHERE id = $1`,
        [row.id, outcome, outcome === 'unmatched' || outcome === 'reported' ? null : row.key],
      )
    }
    return rows.length
  }

  async prune(batch = 1000): Promise<number> {
    let deleted = 0
    for (;;) {
      const result = await this.#db.pool.query(
        `DELETE FROM webhook_events WHERE id IN (
           SELECT id FROM webhook_events WHERE received_at <= now() - make_interval(days => $1) LIMIT $2)`,
        [this.#config.webhookRetentionDays, batch],
      )
      deleted += result.rowCount ?? 0
      if ((result.rowCount ?? 0) < batch) {
        if (deleted > 0) this.#logger.log(`pruned ${deleted} webhook events`)
        return deleted
      }
    }
  }
}
