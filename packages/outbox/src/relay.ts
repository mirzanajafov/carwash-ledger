import { setTimeout as sleep } from 'node:timers/promises'
import { failpoint } from '@carwash/failpoints'
import { checkout } from '@carwash/pg'
import type pg from 'pg'
import { LANES } from './events.ts'

export interface OutboxRow {
  id: string
  lane: number
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
  pauseMs: number
  lockClass: number
}

export const RELAY_DEFAULTS: RelayOptions = { workers: 4, batch: 500, pollMs: 50, pauseMs: 10, lockClass: 0x0b0c }

export interface Relayed {
  lanes: number[]
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

const LOCK = 'SELECT lane FROM unnest($2::int[]) AS lane WHERE pg_try_advisory_lock($1, lane)'

const UNLOCK = 'SELECT pg_advisory_unlock($1, lane) FROM unnest($2::int[]) AS lane'

const BATCH = `
  SELECT o.id::text AS id, o.lane, o.event_id::text AS "eventId", o.topic, o.key, o.type, o.payload, o.created_at AS "createdAt"
  FROM outbox o
  WHERE o.lane = ANY($1::smallint[]) AND o.published_at IS NULL
  ORDER BY o.id
  LIMIT $2`

export async function relayOnce(client: pg.ClientBase, publisher: Publisher, options: RelayOptions = RELAY_DEFAULTS): Promise<Relayed | null> {
  const candidates = (await client.query<{ lane: number }>(CANDIDATES)).rows.map((row) => row.lane)
  if (candidates.length === 0) return null
  let lanes = (await client.query<{ lane: number }>(LOCK, [options.lockClass, candidates])).rows.map((row) => row.lane)
  if (lanes.length === 0) return null
  try {
    const batch = (await client.query<OutboxRow>(BATCH, [lanes, options.batch])).rows
    const used = new Set(batch.map((row) => row.lane))
    const spare = lanes.filter((lane) => !used.has(lane))
    if (spare.length > 0) {
      await client.query(UNLOCK, [options.lockClass, spare])
      lanes = lanes.filter((lane) => used.has(lane))
    }
    if (batch.length === 0) return null
    failpoint('relay.before_produce')
    await publisher.publish(batch)
    failpoint('relay.after_produce')
    await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[]) AND published_at IS NULL', [
      batch.map((row) => row.id),
    ])
    return { lanes, published: batch.length }
  } finally {
    await client.query(UNLOCK, [options.lockClass, lanes])
  }
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
        if (!relayed) await sleep(this.#options.pollMs, undefined, { signal }).catch(() => undefined)
        else if (relayed.published < this.#options.batch) await sleep(this.#options.pauseMs, undefined, { signal }).catch(() => undefined)
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
