import { setTimeout as sleep } from 'node:timers/promises'
import type pg from 'pg'
import { SIGNATURE_HEADER, signatureHeader } from './signature.ts'

export interface DeliveryOptions {
  url: string
  secret: string
  batch?: number
  intervalMs?: number
  timeoutMs?: number
  maxAttempts?: number
  log?: (message: string) => void
}

interface Claimed {
  id: string
  attempts: number
  body: string
}

const CLAIM = `
UPDATE deliveries d
SET due_at = now() + make_interval(secs => $2), attempts = d.attempts + 1
FROM (
  SELECT id FROM deliveries
  WHERE delivered_at IS NULL AND failed_at IS NULL AND NOT dropped AND due_at <= now()
  ORDER BY due_at, id
  LIMIT $1
  FOR UPDATE SKIP LOCKED
) due, events e
WHERE d.id = due.id AND e.id = d.event_id
RETURNING d.id, d.attempts, e.payload::text AS body`

export function retryDelaySeconds(attempts: number): number {
  return Math.min(60, 2 ** (attempts - 1))
}

export class WebhookSender {
  readonly #pool: pg.Pool
  readonly #options: Required<DeliveryOptions>
  #running = false
  #loop: Promise<void> | undefined

  constructor(pool: pg.Pool, options: DeliveryOptions) {
    this.#pool = pool
    this.#options = {
      batch: 20,
      intervalMs: 200,
      timeoutMs: 5000,
      maxAttempts: 10,
      log: (message) => process.stderr.write(`${message}\n`),
      ...options,
    }
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#loop = (async () => {
      while (this.#running) {
        try {
          const sent = await this.tick()
          if (sent < this.#options.batch) await sleep(this.#options.intervalMs)
        } catch (error) {
          this.#options.log(`psp webhooks: ${error instanceof Error ? error.message : String(error)}`)
          await sleep(this.#options.intervalMs)
        }
      }
    })()
  }

  async stop(): Promise<void> {
    this.#running = false
    await this.#loop
  }

  async tick(): Promise<number> {
    const leaseSeconds = Math.ceil(this.#options.timeoutMs / 1000) + 5
    const { rows } = await this.#pool.query<Claimed>(CLAIM, [this.#options.batch, leaseSeconds])
    await Promise.all(rows.map((row) => this.#send(row)))
    return rows.length
  }

  async #send(delivery: Claimed): Promise<void> {
    let error: string | undefined
    try {
      const response = await fetch(this.#options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signatureHeader(this.#options.secret, delivery.body, Math.floor(Date.now() / 1000)),
        },
        body: delivery.body,
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      })
      await response.arrayBuffer().catch(() => undefined)
      if (response.ok) {
        await this.#pool.query('UPDATE deliveries SET delivered_at = now(), last_error = NULL WHERE id = $1', [delivery.id])
        return
      }
      error = `HTTP ${response.status}`
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    if (delivery.attempts >= this.#options.maxAttempts) {
      await this.#pool.query('UPDATE deliveries SET failed_at = now(), last_error = $2 WHERE id = $1', [delivery.id, error])
    } else {
      await this.#pool.query('UPDATE deliveries SET due_at = now() + make_interval(secs => $2), last_error = $3 WHERE id = $1', [
        delivery.id,
        retryDelaySeconds(delivery.attempts),
        error,
      ])
    }
  }
}
