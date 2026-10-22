import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { checkout, firstRow } from '@carwash/pg'
import type pg from 'pg'
import type { Behaviour, Faults, OperationKind, TokenEffect } from './faults.ts'
import { HttpError } from './http.ts'

export interface PspSettings {
  authorizationTtlSeconds: number
  idempotencyWindowSeconds: number
  webhooks: boolean
}

export interface Outcome {
  status: 'succeeded' | 'declined'
  httpStatus: number
  reason?: string
  chargeId?: string
  amount?: number
  currency?: string
  destination?: string
}

export interface OperationRequest {
  key: string
  kind: OperationKind
  hash: Buffer
  token: TokenEffect
  apply(client: pg.PoolClient, behaviour: Behaviour): Promise<Outcome>
}

export interface Answer {
  status: number
  body: unknown
  replayed: boolean
  afterCommit: Behaviour['afterCommit']
}

interface ChargeRow {
  id: string
  status: 'authorized' | 'captured' | 'canceled'
  currency: string
  authorized_amount: string
  captured_amount: string
  refunded_amount: string
  expires_at: Date
  expired: boolean
}

interface OperationRow {
  id: string
  idempotency_key: string
  kind: OperationKind
  status: 'succeeded' | 'declined'
  reason: string | null
  amount: string | null
  currency: string | null
  destination: string | null
  created_at: Date
  charge_id: string | null
  charge_status: ChargeRow['status'] | null
  charge_currency: string | null
  authorized_amount: string | null
  captured_amount: string | null
  refunded_amount: string | null
  expires_at: Date | null
  expired: boolean | null
}

const CHARGE_COLUMNS = `c.id, c.status, c.currency, c.authorized_amount, c.captured_amount, c.refunded_amount, c.expires_at, c.expires_at <= now() AS expired`

const SELECT_OPERATION = `
SELECT o.id, o.idempotency_key, o.kind, o.status, o.reason, o.amount, o.currency, o.destination, o.created_at, o.charge_id,
       c.status AS charge_status, c.currency AS charge_currency, c.authorized_amount, c.captured_amount, c.refunded_amount,
       c.expires_at, c.expires_at <= now() AS expired
FROM operations o
LEFT JOIN charges c ON c.id = o.charge_id`

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

function chargeJson(row: ChargeRow) {
  return {
    id: row.id,
    object: 'charge',
    status: row.status,
    currency: row.currency,
    authorized_amount: Number(row.authorized_amount),
    captured_amount: Number(row.captured_amount),
    refunded_amount: Number(row.refunded_amount),
    expires_at: seconds(row.expires_at),
  }
}

function operationJson(row: OperationRow) {
  return {
    id: row.id,
    object: 'operation',
    idempotency_key: row.idempotency_key,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    amount: row.amount === null ? null : Number(row.amount),
    currency: row.currency,
    destination: row.destination,
    created: seconds(row.created_at),
    charge:
      row.charge_id === null
        ? null
        : chargeJson({
            id: row.charge_id,
            status: row.charge_status!,
            currency: row.charge_currency!,
            authorized_amount: row.authorized_amount!,
            captured_amount: row.captured_amount!,
            refunded_amount: row.refunded_amount!,
            expires_at: row.expires_at!,
            expired: row.expired!,
          }),
  }
}

export function requestHash(method: string, path: string, body: unknown): Buffer {
  return createHash('sha256')
    .update(`${method} ${path}\n${canonicalJson(body)}`)
    .digest()
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export class Psp {
  readonly #pool: pg.Pool
  readonly #faults: Faults
  readonly #settings: PspSettings

  constructor(pool: pg.Pool, faults: Faults, settings: PspSettings) {
    this.#pool = pool
    this.#faults = faults
    this.#settings = settings
  }

  async execute(request: OperationRequest): Promise<Answer> {
    const behaviour = this.#faults.behaviour(request.key, request.kind, request.token)
    if (behaviour.slowMs > 0) await sleep(behaviour.slowMs)
    const lease = await checkout(this.#pool)
    const { client } = lease
    let broken = false
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [request.key])
      const stored = await client.query<{ request_hash: Buffer; http_status: number; response: unknown }>(
        `SELECT request_hash, http_status, response FROM idempotency_keys
         WHERE key = $1 AND created_at > now() - make_interval(secs => $2)`,
        [request.key, this.#settings.idempotencyWindowSeconds],
      )
      const previous = stored.rows[0]
      if (previous) {
        await client.query('COMMIT')
        if (!previous.request_hash.equals(request.hash)) {
          throw new HttpError(422, 'idempotency_key_reused', 'this idempotency key was used with a different request')
        }
        return { status: previous.http_status, body: previous.response, replayed: true, afterCommit: 'answer' }
      }
      if (behaviour.fail) throw new HttpError(500, 'processing_error', 'the PSP failed before doing anything')

      const outcome = await request.apply(client, behaviour)
      const operationId = `op_${randomUUID()}`
      await client.query(
        `INSERT INTO operations (id, idempotency_key, kind, status, reason, charge_id, amount, currency, destination)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          operationId,
          request.key,
          request.kind,
          outcome.status,
          outcome.reason ?? null,
          outcome.chargeId ?? null,
          outcome.amount ?? null,
          outcome.currency ?? null,
          outcome.destination ?? null,
        ],
      )
      const body = await this.#render(client, operationId)
      await client.query(
        `INSERT INTO idempotency_keys (key, request_hash, operation_id, http_status, response)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key) DO UPDATE SET request_hash = excluded.request_hash, operation_id = excluded.operation_id,
           http_status = excluded.http_status, response = excluded.response, created_at = now()`,
        [request.key, request.hash, operationId, outcome.httpStatus, body],
      )
      await this.#enqueueWebhook(client, operationId, outcome.status, body, behaviour)
      await client.query('COMMIT')
      return { status: outcome.httpStatus, body, replayed: false, afterCommit: behaviour.afterCommit }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        broken = true
      })
      throw error
    } finally {
      lease.release(broken)
    }
  }

  async chargeToken(chargeId: string): Promise<string> {
    const { rows } = await this.#pool.query<{ token: string }>('SELECT token FROM charges WHERE id = $1', [chargeId])
    if (!rows[0]) throw new HttpError(404, 'charge_not_found', `no charge ${chargeId}`)
    return rows[0].token
  }

  async charge(chargeId: string): Promise<unknown> {
    const { rows } = await this.#pool.query<ChargeRow>(`SELECT ${CHARGE_COLUMNS} FROM charges c WHERE c.id = $1`, [chargeId])
    if (!rows[0]) throw new HttpError(404, 'charge_not_found', `no charge ${chargeId}`)
    return chargeJson(rows[0])
  }

  async operation(key: string): Promise<unknown> {
    const { rows } = await this.#pool.query<OperationRow>(`${SELECT_OPERATION} WHERE o.idempotency_key = $1 ORDER BY o.created_at DESC LIMIT 1`, [key])
    if (!rows[0]) throw new HttpError(404, 'operation_not_found', `no operation with idempotency key ${key}`)
    return operationJson(rows[0])
  }

  async sweepExpiredKeys(batch = 1000): Promise<number> {
    let deleted = 0
    for (;;) {
      const result = await this.#pool.query(
        `DELETE FROM idempotency_keys WHERE key IN (
           SELECT key FROM idempotency_keys WHERE created_at <= now() - make_interval(secs => $1) LIMIT $2)`,
        [this.#settings.idempotencyWindowSeconds, batch],
      )
      deleted += result.rowCount ?? 0
      if ((result.rowCount ?? 0) < batch) return deleted
    }
  }

  async authorize(client: pg.PoolClient, behaviour: Behaviour, input: AuthorizeInput): Promise<Outcome> {
    const { amount, currency } = input
    if (behaviour.decline) return { status: 'declined', httpStatus: 402, reason: 'card_declined', amount, currency }
    const chargeId = `ch_${randomUUID()}`
    const ttl = input.effect.kind === 'expire_authorization' ? 0 : this.#settings.authorizationTtlSeconds
    await client.query(
      `INSERT INTO charges (id, token, currency, authorized_amount, status, expires_at)
       VALUES ($1, $2, $3, $4, 'authorized', now() + make_interval(secs => $5))`,
      [chargeId, input.token, currency, amount, ttl],
    )
    return { status: 'succeeded', httpStatus: 200, chargeId, amount, currency }
  }

  async capture(client: pg.PoolClient, behaviour: Behaviour, chargeId: string, amount: number | undefined): Promise<Outcome> {
    const charge = await this.#lockCharge(client, chargeId)
    const captured = misstated(behaviour, amount ?? Number(charge.authorized_amount))
    const declined = (httpStatus: number, reason: string): Outcome => ({
      status: 'declined',
      httpStatus,
      reason,
      chargeId,
      amount: captured,
      currency: charge.currency,
    })
    if (charge.status === 'canceled') return declined(409, 'charge_canceled')
    if (charge.status === 'captured') return declined(409, 'charge_already_captured')
    if (charge.expired) return declined(402, 'authorization_expired')
    if (captured > Number(charge.authorized_amount)) return declined(409, 'amount_exceeds_authorization')
    await client.query(`UPDATE charges SET status = 'captured', captured_amount = $2 WHERE id = $1`, [chargeId, captured])
    return { status: 'succeeded', httpStatus: 200, chargeId, amount: captured, currency: charge.currency }
  }

  async cancel(client: pg.PoolClient, chargeId: string): Promise<Outcome> {
    const charge = await this.#lockCharge(client, chargeId)
    const amount = Number(charge.authorized_amount)
    if (charge.status !== 'authorized') {
      const reason = charge.status === 'captured' ? 'charge_already_captured' : 'charge_canceled'
      return { status: 'declined', httpStatus: 409, reason, chargeId, amount, currency: charge.currency }
    }
    await client.query(`UPDATE charges SET status = 'canceled' WHERE id = $1`, [chargeId])
    return { status: 'succeeded', httpStatus: 200, chargeId, amount, currency: charge.currency }
  }

  async refund(client: pg.PoolClient, behaviour: Behaviour, chargeId: string, requested: number): Promise<Outcome> {
    const amount = misstated(behaviour, requested)
    const charge = await this.#lockCharge(client, chargeId)
    const declined = (reason: string): Outcome => ({ status: 'declined', httpStatus: 409, reason, chargeId, amount, currency: charge.currency })
    if (charge.status !== 'captured') return declined('charge_not_captured')
    if (Number(charge.refunded_amount) + amount > Number(charge.captured_amount)) return declined('refund_exceeds_captured')
    await client.query('UPDATE charges SET refunded_amount = refunded_amount + $2 WHERE id = $1', [chargeId, amount])
    return { status: 'succeeded', httpStatus: 200, chargeId, amount, currency: charge.currency }
  }

  payout(behaviour: Behaviour, input: PayoutInput): Outcome {
    const { currency, destination } = input
    if (behaviour.decline) {
      return { status: 'declined', httpStatus: 402, reason: 'payout_rejected', amount: input.amount, currency, destination }
    }
    return { status: 'succeeded', httpStatus: 200, amount: misstated(behaviour, input.amount), currency, destination }
  }

  async #lockCharge(client: pg.PoolClient, chargeId: string): Promise<ChargeRow> {
    const { rows } = await client.query<ChargeRow>(`SELECT ${CHARGE_COLUMNS} FROM charges c WHERE c.id = $1 FOR UPDATE`, [chargeId])
    if (!rows[0]) throw new HttpError(404, 'charge_not_found', `no charge ${chargeId}`)
    return rows[0]
  }

  async #render(client: pg.PoolClient, operationId: string): Promise<unknown> {
    return operationJson(firstRow(await client.query<OperationRow>(`${SELECT_OPERATION} WHERE o.id = $1`, [operationId])))
  }

  async #enqueueWebhook(client: pg.PoolClient, operationId: string, status: Outcome['status'], body: unknown, behaviour: Behaviour): Promise<void> {
    if (!this.#settings.webhooks) return
    const eventId = `evt_${randomUUID()}`
    const type = `operation.${status}`
    const payload = { id: eventId, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object: body } }
    await client.query('INSERT INTO events (id, operation_id, type, payload) VALUES ($1, $2, $3, $4)', [eventId, operationId, type, payload])
    const { webhook, draw } = behaviour
    let delay = 0
    if (webhook.has('delay')) delay += 30 + Math.floor(draw('webhook.delay.s') * 91)
    if (webhook.has('reorder')) delay += 2 + Math.floor(draw('webhook.reorder.s') * 9)
    const dueIn = [delay]
    if (webhook.has('duplicate')) dueIn.push(delay + Math.floor(draw('webhook.duplicate.s') * 6))
    for (const seconds of dueIn) {
      await client.query('INSERT INTO deliveries (event_id, due_at, dropped) VALUES ($1, now() + make_interval(secs => $2), $3)', [
        eventId,
        seconds,
        webhook.has('drop'),
      ])
    }
  }
}

function misstated(behaviour: Behaviour, amount: number): number {
  if (!behaviour.wrongAmount) return amount
  return amount > 1 ? amount - 1 : amount + 1
}

export interface PayoutInput {
  amount: number
  currency: string
  destination: string
}

export interface AuthorizeInput {
  amount: number
  currency: string
  token: string
  effect: TokenEffect
}
