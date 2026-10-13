import { setTimeout as sleep } from 'node:timers/promises'
import { failpoint } from '@carwash/failpoints'
import { checkout } from '@carwash/pg'
import type pg from 'pg'
import { LANES } from './events.ts'

export interface OutboxRow {
  id: string
  eventId: string
  topic: string
  key: string
  type: string
  payload: unknown
  createdAt: Date
}

export interface Publisher {
  publish(rows: readonly OutboxRow[]): Promise<void>
}

export interface RelayOptions {
  workers: number
  batch: number
  pollMs: number
  lockClass: number
}

export const RELAY_DEFAULTS: RelayOptions = { workers: 4, batch: 500, pollMs: 50, lockClass: 0x0b0c }

export interface Relayed {
  lane: number
  published: number
}

export type RelayLog = (message: string) => void

const CANDIDATES = `
  SELECT lanes.lane
  FROM generate_series(0, ${LANES - 1}) AS lanes(lane)
  CROSS JOIN LATERAL (
    SELECT o.id FROM outbox o WHERE o.lane = lanes.lane AND o.published_at IS NULL ORDER BY o.id LIMIT 1
  ) oldest
  ORDER BY oldest.id`

const BATCH = `
  SELECT o.id::text AS id, o.event_id::text AS "eventId", o.topic, o.key, o.type, o.payload, o.created_at AS "createdAt"
  FROM outbox o
  WHERE o.lane = $1 AND o.published_at IS NULL
  ORDER BY o.id
  LIMIT $2`

export async function relayOnce(client: pg.ClientBase, publisher: Publisher, options: RelayOptions = RELAY_DEFAULTS): Promise<Relayed | null> {
  const { rows: lanes } = await client.query<{ lane: number }>(CANDIDATES)
  for (const { lane } of lanes) {
    const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS locked', [options.lockClass, lane])
    if (!rows[0]!.locked) continue
    try {
      const batch = (await client.query<OutboxRow>(BATCH, [lane, options.batch])).rows
      if (batch.length === 0) continue
      failpoint('relay.before_produce')
      await publisher.publish(batch)
      failpoint('relay.after_produce')
      await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[]) AND published_at IS NULL', [
        batch.map((row) => row.id),
      ])
      return { lane, published: batch.length }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [options.lockClass, lane])
    }
  }
  return null
}

export class Relay {
  readonly #pool: pg.Pool
  readonly #publisher: Publisher
  readonly #options: RelayOptions
  readonly #log: RelayLog
  readonly #stop = new AbortController()
  readonly #loops: Promise<void>[] = []
  published = 0

  constructor(pool: pg.Pool, publisher: Publisher, options: Partial<RelayOptions> = {}, log: RelayLog = () => undefined) {
    this.#pool = pool
    this.#publisher = publisher
    this.#options = { ...RELAY_DEFAULTS, ...options }
    this.#log = log
  }

  start(): void {
    for (let worker = 0; worker < this.#options.workers; worker++) this.#loops.push(this.#loop())
  }

  async stop(): Promise<void> {
    this.#stop.abort()
    await Promise.all(this.#loops)
  }

  async #loop(): Promise<void> {
    const signal = this.#stop.signal
    let failures = 0
    while (!signal.aborted) {
      try {
        const relayed = await this.#cycle()
        failures = 0
        if (relayed) this.published += relayed.published
        if (!relayed || relayed.published < this.#options.batch) await sleep(this.#options.pollMs, undefined, { signal }).catch(() => undefined)
      } catch (error) {
        failures++
        if (failures === 1 || failures % 50 === 0) this.#log(`relay: ${(error as Error).message}`)
        await sleep(Math.min(2000, 50 * 2 ** Math.min(failures, 6)), undefined, { signal }).catch(() => undefined)
      }
    }
  }

  async #cycle(): Promise<Relayed | null> {
    const lease = await checkout(this.#pool)
    let broken = false
    try {
      return await relayOnce(lease.client, this.#publisher, this.#options)
    } catch (error) {
      broken = true
      throw error
    } finally {
      lease.release(broken)
    }
  }
}
