import { failpoint } from '@carwash/failpoints'
import { Injectable, Logger } from '@nestjs/common'
import type { WebhookReceipt } from '@carwash/contracts'
import { Database } from '../db/database.ts'
import { DomainError } from '../domain-errors.ts'
import { recordAnomaly } from '../payments/anomalies.repository.ts'
import { findAttempt } from '../payments/attempts.repository.ts'
import { AttemptsService } from '../payments/attempts.service.ts'
import { PspClient } from '../psp/psp.client.ts'
import { PspAnswerRejectedError, pspUnavailable } from '../psp/psp.errors.ts'
import { markWebhookChecked, pruneWebhookEvents, recordWebhook, unmatchedWebhooks, webhookOutcome, type WebhookOutcome } from './webhooks.repository.ts'

export type CheckOutcome = Exclude<WebhookOutcome, 'reported'>

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
    throw new DomainError('invalid', 'invalid_event', 'the event needs an id, a type and data.object.idempotency_key')
  }
  return { id, type, attemptKey: key, payload: body }
}

@Injectable()
export class WebhooksService {
  readonly #db: Database
  readonly #attempts: AttemptsService
  readonly #psp: PspClient
  readonly #logger = new Logger('webhooks')

  constructor(db: Database, attempts: AttemptsService, psp: PspClient) {
    this.#db = db
    this.#attempts = attempts
    this.#psp = psp
  }

  async handle(event: PspEvent): Promise<WebhookReceipt> {
    const seen = await webhookOutcome(this.#db.pool, event.id)
    if (seen !== undefined) return { received: true, outcome: seen, duplicate: true }
    const outcome = await this.check(event.attemptKey)
    await recordWebhook(this.#db.pool, {
      id: event.id,
      type: event.type,
      attemptId: outcome === 'unmatched' ? null : event.attemptKey,
      outcome,
      payload: event.payload,
    })
    return { received: true, outcome }
  }

  async check(attemptKey: string): Promise<CheckOutcome> {
    const attempt = UUID.test(attemptKey) ? await findAttempt(this.#db.pool, attemptKey) : undefined
    if (!attempt) return 'unmatched'
    if (attempt.status !== 'pending') return 'already'
    const reply = await this.#psp.pull(attempt.id)
    if (reply.kind === 'unknown') throw pspUnavailable(reply.reason)
    if (reply.kind === 'none') return 'not_at_psp'
    failpoint('webhook.after_pull')
    try {
      return await this.#attempts.receive(await this.#attempts.callFor(attempt), reply.body)
    } catch (error) {
      if (error instanceof PspAnswerRejectedError) return 'anomaly'
      throw error
    }
  }

  async recheckUnmatched(reportAfterSeconds = 3600, batch = 50): Promise<number> {
    const rows = await unmatchedWebhooks(this.#db.pool, reportAfterSeconds, batch)
    for (const row of rows) {
      let outcome: WebhookOutcome = await this.check(row.key).catch(() => 'unmatched')
      if (outcome === 'unmatched' && row.overdue) {
        await recordAnomaly(this.#db.pool, null, 'unmatched_webhook', { event: row.id, key: row.key })
        outcome = 'reported'
      }
      await markWebhookChecked(this.#db.pool, row.id, outcome, outcome === 'unmatched' || outcome === 'reported' ? null : row.key)
    }
    return rows.length
  }

  async prune(retentionDays: number): Promise<number> {
    const deleted = await pruneWebhookEvents(this.#db.pool, retentionDays)
    if (deleted > 0) this.#logger.log(`pruned ${deleted} webhook events`)
    return deleted
  }
}
