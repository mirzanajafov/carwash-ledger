import { failpoint } from '@carwash/failpoints'
import { Inject, Injectable } from '@nestjs/common'
import { requestHash } from '@carwash/http'
import { deleteInBatches, firstRow, type Transaction } from '@carwash/pg'
import { CORE_CONFIG, type CoreConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { DomainError, invalidInput, type Failure } from '../domain-errors.ts'
import { asPaymentId, asPayoutId, asRefundId, type PaymentId, type PayoutId, type RefundId } from '../ids.ts'

export interface OwnedKey {
  clientId: string
  key: string
  leaseId: string
  paymentId: PaymentId | null
  refundId: RefundId | null
  payoutId: PayoutId | null
}

export interface Final {
  status: number
  body: unknown
}

export interface Reply extends Final {
  replayed: boolean
}

export interface KeyedRequest {
  clientId: string
  key: unknown
  method: string
  path: string
  body: unknown
}

export type Begun = { kind: 'owned'; owned: OwnedKey } | { kind: 'replay'; status: number; body: unknown }

export interface ResourceRefs {
  paymentId?: PaymentId
  refundId?: RefundId
  payoutId?: PayoutId
}

export type IdempotencyState = 'started' | 'finished'

interface KeyRow {
  request_hash: Buffer
  state: IdempotencyState
  payment_id: string | null
  refund_id: string | null
  payout_id: string | null
  leased: boolean
  response_status: number | null
  response_body: unknown
}

function inProgress(): DomainError {
  return new DomainError('conflict', 'request_in_progress', 'a request with this idempotency key is still being processed', 1)
}

function leaseLost(): DomainError {
  return new DomainError('conflict', 'request_in_progress', 'another request with this idempotency key took it over', 1)
}

const OWNED = 'client_id = $1 AND key = $2 AND lease_id = $3'

const REFUSALS: ReadonlySet<Failure> = new Set(['invalid', 'not_found', 'conflict', 'unprocessable'])

function refused(error: unknown): boolean {
  return error instanceof DomainError && REFUSALS.has(error.failure)
}

@Injectable()
export class IdempotencyService {
  readonly #db: Database
  readonly #config: CoreConfig

  constructor(db: Database, @Inject(CORE_CONFIG) config: CoreConfig) {
    this.#db = db
    this.#config = config
  }

  async run(request: KeyedRequest, work: (owned: OwnedKey) => Promise<Final>): Promise<Reply> {
    const { key } = request
    if (typeof key !== 'string' || key.length === 0 || key.length > 255) {
      throw invalidInput('every POST needs an Idempotency-Key header of 1 to 255 characters')
    }
    const begun = await this.begin(request.clientId, key, request.method, request.path, request.body)
    if (begun.kind === 'replay') return { status: begun.status, body: begun.body, replayed: true }
    try {
      return { ...(await work(begun.owned)), replayed: false }
    } catch (error) {
      await (refused(error) ? this.abandon(begun.owned) : this.release(begun.owned)).catch(() => undefined)
      throw error
    }
  }

  async begin(clientId: string, key: string, method: string, path: string, body: unknown): Promise<Begun> {
    const hash = requestHash(method, path, body)
    const keyParams = [clientId, key]
    return this.#db.transaction(async (client) => {
      await client.query('DELETE FROM idempotency_keys WHERE client_id = $1 AND key = $2 AND created_at <= now() - make_interval(secs => $3)', [
        ...keyParams,
        this.#config.idempotencyWindowSeconds,
      ])
      const inserted = await client.query<{ lease_id: string }>(
        `INSERT INTO idempotency_keys (client_id, key, method, path, request_hash, locked_until, lease_id)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), gen_random_uuid())
         ON CONFLICT DO NOTHING
         RETURNING lease_id`,
        [...keyParams, method, path, hash, this.#config.leaseSeconds],
      )
      const [created] = inserted.rows
      if (created) {
        const leaseId = created.lease_id
        return { kind: 'owned', owned: { clientId, key, leaseId, paymentId: null, refundId: null, payoutId: null } }
      }
      const { rows } = await client.query<KeyRow>(
        `SELECT request_hash, state, payment_id, refund_id, payout_id, locked_until > now() AS leased,
                response_status, response_body
         FROM idempotency_keys WHERE client_id = $1 AND key = $2 FOR UPDATE`,
        keyParams,
      )
      const row = rows[0]
      if (!row) throw inProgress()
      if (!row.request_hash.equals(hash)) {
        throw new DomainError('unprocessable', 'idempotency_key_reused', 'this idempotency key was already used with a different request')
      }
      if (row.state === 'finished') {
        if (row.response_status === null) throw new Error(`idempotency key ${key} is finished without a stored answer`)
        return { kind: 'replay', status: row.response_status, body: row.response_body }
      }
      if (row.leased) throw inProgress()
      const taken = await client.query<{ lease_id: string }>(
        `UPDATE idempotency_keys SET locked_until = now() + make_interval(secs => $3), lease_id = gen_random_uuid()
         WHERE client_id = $1 AND key = $2 RETURNING lease_id`,
        [...keyParams, this.#config.leaseSeconds],
      )
      return {
        kind: 'owned',
        owned: {
          clientId,
          key,
          leaseId: firstRow(taken).lease_id,
          paymentId: row.payment_id === null ? null : asPaymentId(row.payment_id),
          refundId: row.refund_id === null ? null : asRefundId(row.refund_id),
          payoutId: row.payout_id === null ? null : asPayoutId(row.payout_id),
        },
      }
    })
  }

  async recordPoint(client: Transaction, owned: OwnedKey, point: string, refs: ResourceRefs): Promise<void> {
    const recorded = await client.query(
      `UPDATE idempotency_keys
       SET recovery_point = $4, payment_id = coalesce($5, payment_id), refund_id = coalesce($6, refund_id), payout_id = coalesce($7, payout_id)
       WHERE ${OWNED} AND state = 'started'`,
      [owned.clientId, owned.key, owned.leaseId, point, refs.paymentId ?? null, refs.refundId ?? null, refs.payoutId ?? null],
    )
    if (recorded.rowCount !== 1) throw leaseLost()
  }

  async finish(client: Transaction, owned: OwnedKey, final: Final): Promise<Final> {
    failpoint('request.before_finish')
    const finished = await client.query(
      `UPDATE idempotency_keys
       SET state = 'finished', response_status = $4, response_body = $5, locked_until = NULL
       WHERE ${OWNED} AND state = 'started'`,
      [owned.clientId, owned.key, owned.leaseId, final.status, JSON.stringify(final.body)],
    )
    if (finished.rowCount !== 1) throw leaseLost()
    return final
  }

  async release(owned: OwnedKey): Promise<void> {
    await this.#db.pool.query(`UPDATE idempotency_keys SET locked_until = NULL WHERE ${OWNED} AND state = 'started'`, [
      owned.clientId,
      owned.key,
      owned.leaseId,
    ])
  }

  async abandon(owned: OwnedKey): Promise<void> {
    const deleted = await this.#db.pool.query(`DELETE FROM idempotency_keys WHERE ${OWNED} AND state = 'started' AND recovery_point = 'started'`, [
      owned.clientId,
      owned.key,
      owned.leaseId,
    ])
    if (deleted.rowCount === 0) await this.release(owned)
  }

  sweep(): Promise<number> {
    return deleteInBatches(1000, (limit) =>
      this.#db.pool.query(
        `DELETE FROM idempotency_keys WHERE (client_id, key) IN (
           SELECT client_id, key FROM idempotency_keys WHERE created_at <= now() - make_interval(secs => $1) LIMIT $2)`,
        [this.#config.idempotencyWindowSeconds, limit],
      ),
    )
  }
}
