import { Inject, Injectable } from '@nestjs/common'
import type { Response } from 'express'
import type pg from 'pg'
import type { AuthedRequest } from '../auth/access.guard.ts'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { ApiError } from '../http/api-error.ts'
import { requestHash } from './request-hash.ts'

export interface OwnedKey {
  clientId: string
  key: string
  recoveryPoint: string
  paymentId: string | null
  refundId: string | null
  payoutId: string | null
}

export interface Final {
  status: number
  body: unknown
}

export type Begun = { kind: 'owned'; owned: OwnedKey } | { kind: 'replay'; status: number; body: unknown }

export interface ResourceRefs {
  paymentId?: string
  refundId?: string
  payoutId?: string
}

interface KeyRow {
  request_hash: Buffer
  state: 'started' | 'finished'
  recovery_point: string
  payment_id: string | null
  refund_id: string | null
  payout_id: string | null
  leased: boolean
  response_status: number | null
  response_body: unknown
}

export function inProgress(): ApiError {
  return new ApiError(409, 'request_in_progress', 'a request with this idempotency key is still being processed', { 'retry-after': '1' })
}

@Injectable()
export class IdempotencyService {
  readonly #db: Database
  readonly #config: ApiConfig

  constructor(db: Database, @Inject(API_CONFIG) config: ApiConfig) {
    this.#db = db
    this.#config = config
  }

  async run(request: AuthedRequest, response: Response, work: (owned: OwnedKey) => Promise<Final>): Promise<void> {
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length === 0 || key.length > 255) {
      throw new ApiError(400, 'invalid_request', 'every POST needs an Idempotency-Key header of 1 to 255 characters')
    }
    const begun = await this.begin(request.client.id, key, request.method, request.path, request.body ?? {})
    if (begun.kind === 'replay') {
      response.setHeader('idempotent-replayed', 'true')
      response.status(begun.status).json(begun.body)
      return
    }
    try {
      const final = await work(begun.owned)
      response.status(final.status).json(final.body)
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) await this.abandon(begun.owned)
      else await this.release(begun.owned).catch(() => undefined)
      throw error
    }
  }

  async begin(clientId: string, key: string, method: string, path: string, body: unknown): Promise<Begun> {
    const hash = requestHash(method, path, body)
    const keyParams = [clientId, key]
    return this.#db.transaction(async (client) => {
      await client.query(
        'DELETE FROM idempotency_keys WHERE client_id = $1 AND key = $2 AND created_at <= now() - make_interval(secs => $3)',
        [...keyParams, this.#config.idempotencyWindowSeconds],
      )
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (client_id, key, method, path, request_hash, locked_until)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
         ON CONFLICT DO NOTHING`,
        [...keyParams, method, path, hash, this.#config.leaseSeconds],
      )
      if (inserted.rowCount === 1) {
        return { kind: 'owned', owned: { clientId, key, recoveryPoint: 'started', paymentId: null, refundId: null, payoutId: null } }
      }
      const { rows } = await client.query<KeyRow>(
        `SELECT request_hash, state, recovery_point, payment_id, refund_id, payout_id, locked_until > now() AS leased,
                response_status, response_body
         FROM idempotency_keys WHERE client_id = $1 AND key = $2 FOR UPDATE`,
        keyParams,
      )
      const row = rows[0]
      if (!row) throw inProgress()
      if (!row.request_hash.equals(hash)) {
        throw new ApiError(422, 'idempotency_key_reused', 'this idempotency key was already used with a different request')
      }
      if (row.state === 'finished') return { kind: 'replay', status: row.response_status!, body: row.response_body }
      if (row.leased) throw inProgress()
      await client.query(
        'UPDATE idempotency_keys SET locked_until = now() + make_interval(secs => $3) WHERE client_id = $1 AND key = $2',
        [...keyParams, this.#config.leaseSeconds],
      )
      return {
        kind: 'owned',
        owned: {
          clientId,
          key,
          recoveryPoint: row.recovery_point,
          paymentId: row.payment_id,
          refundId: row.refund_id,
          payoutId: row.payout_id,
        },
      }
    })
  }

  async recordPoint(client: pg.ClientBase, owned: OwnedKey, point: string, refs: ResourceRefs): Promise<void> {
    await client.query(
      `UPDATE idempotency_keys
       SET recovery_point = $3, payment_id = coalesce($4, payment_id), refund_id = coalesce($5, refund_id), payout_id = coalesce($6, payout_id)
       WHERE client_id = $1 AND key = $2 AND state = 'started'`,
      [owned.clientId, owned.key, point, refs.paymentId ?? null, refs.refundId ?? null, refs.payoutId ?? null],
    )
    Object.assign(owned, { recoveryPoint: point }, refs)
  }

  async finish(client: pg.ClientBase, owned: OwnedKey, final: Final): Promise<Final> {
    await client.query(
      `UPDATE idempotency_keys
       SET state = 'finished', response_status = $3, response_body = $4, locked_until = NULL
       WHERE client_id = $1 AND key = $2 AND state = 'started'`,
      [owned.clientId, owned.key, final.status, JSON.stringify(final.body)],
    )
    return final
  }

  async release(owned: OwnedKey): Promise<void> {
    await this.#db.pool.query(
      `UPDATE idempotency_keys SET locked_until = NULL WHERE client_id = $1 AND key = $2 AND state = 'started'`,
      [owned.clientId, owned.key],
    )
  }

  async abandon(owned: OwnedKey): Promise<void> {
    const deleted = await this.#db.pool.query(
      `DELETE FROM idempotency_keys WHERE client_id = $1 AND key = $2 AND state = 'started' AND recovery_point = 'started'`,
      [owned.clientId, owned.key],
    )
    if (deleted.rowCount === 0) await this.release(owned)
  }

  async sweep(batch = 1000): Promise<number> {
    let deleted = 0
    for (;;) {
      const result = await this.#db.pool.query(
        `DELETE FROM idempotency_keys WHERE (client_id, key) IN (
           SELECT client_id, key FROM idempotency_keys WHERE created_at <= now() - make_interval(secs => $1) LIMIT $2)`,
        [this.#config.idempotencyWindowSeconds, batch],
      )
      deleted += result.rowCount ?? 0
      if ((result.rowCount ?? 0) < batch) return deleted
    }
  }
}
