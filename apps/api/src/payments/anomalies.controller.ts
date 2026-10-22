import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common'
import { postInTransaction } from '@carwash/ledger'
import { firstRow } from '@carwash/pg'
import type pg from 'pg'
import { AdminOnly, type AuthedRequest } from '../auth/access.guard.ts'
import { Database } from '../db/database.ts'
import { journalEvents } from '../events/events.ts'
import { ApiError } from '../http/api-error.ts'
import { Chart } from '../ledger/chart.service.ts'
import { checkAnswer } from '../psp/answers.ts'
import { PspClient } from '../psp/psp.client.ts'
import { AttemptsService, pspUnavailable } from './attempts.service.ts'
import { ATTEMPT_COLUMNS, loadPayout, type AttemptRecord } from './records.ts'

const ACCEPTABLE = new Set(['capture', 'refund', 'payout'])

interface AnomalyRow {
  id: string
  kind: string
  created_at: Date
  details: { problems?: string[]; answer?: { amount?: unknown } } | null
  resolution: string | null
  resolved_at: Date | null
  resolver: string | null
  attempt_id: string | null
  attempt_kind: string | null
  attempt_status: string | null
  amount: string | null
  currency: string | null
  payment_id: string | null
  refund_id: string | null
  payout_id: string | null
  merchant: string | null
}

const SELECT = `
  SELECT an.id::text, an.kind, an.created_at, an.details, an.resolution, an.resolved_at, rc.name AS resolver,
         a.id AS attempt_id, a.kind::text AS attempt_kind, a.status::text AS attempt_status, a.amount::text, a.currency,
         a.payment_id::text, a.refund_id::text, a.payout_id::text, m.code AS merchant
  FROM anomalies an
  LEFT JOIN attempts a ON a.id = an.attempt_id
  LEFT JOIN payments p ON p.id = a.payment_id
  LEFT JOIN payouts po ON po.id = a.payout_id
  LEFT JOIN merchants m ON m.id = coalesce(p.merchant_id, po.merchant_id)
  LEFT JOIN api_clients rc ON rc.id = an.resolved_by`

function bankAmount(row: AnomalyRow): string | null {
  const amount = row.details?.answer?.amount
  return Number.isSafeInteger(amount) ? String(amount) : null
}

function acceptable(row: AnomalyRow): boolean {
  return row.kind === 'answer_mismatch' && row.resolved_at === null && row.attempt_status === 'pending' && ACCEPTABLE.has(row.attempt_kind ?? '')
}

function view(row: AnomalyRow) {
  return {
    object: 'anomaly',
    id: row.id,
    kind: row.kind,
    created_at: row.created_at.toISOString(),
    problems: row.details?.problems ?? [],
    attempt: row.attempt_id ? { id: row.attempt_id, kind: row.attempt_kind, status: row.attempt_status, amount: row.amount, currency: row.currency } : null,
    bank_amount: bankAmount(row),
    payment_id: row.payment_id,
    refund_id: row.refund_id,
    payout_id: row.payout_id,
    merchant: row.merchant,
    acceptable: acceptable(row),
    resolution: row.resolution,
    resolved_at: row.resolved_at?.toISOString() ?? null,
    resolved_by: row.resolver,
  }
}

function refuse(message: string): ApiError {
  return new ApiError(409, 'not_acceptable', message)
}

@AdminOnly()
@Controller('v1/admin/anomalies')
export class AnomaliesController {
  readonly #db: Database
  readonly #attempts: AttemptsService
  readonly #psp: PspClient
  readonly #chart: Chart

  constructor(db: Database, attempts: AttemptsService, psp: PspClient, chart: Chart) {
    this.#db = db
    this.#attempts = attempts
    this.#psp = psp
    this.#chart = chart
  }

  @Get()
  async list(@Query('state') state = 'open', @Query('limit') limit = '50') {
    if (state !== 'open' && state !== 'resolved') throw new ApiError(400, 'invalid_request', 'state must be open or resolved')
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200)
    const { rows } = await this.#db.pool.query<AnomalyRow>(`${SELECT} WHERE (an.resolved_at IS NULL) = $1 ORDER BY an.id DESC LIMIT $2`, [state === 'open', n])
    return { object: 'list', data: rows.map(view) }
  }

  @Post(':id/accept')
  @HttpCode(200)
  async accept(@Req() request: AuthedRequest, @Param('id', ParseIntPipe) id: number) {
    const row = await this.#find(id)
    if (!acceptable(row)) {
      throw refuse(
        row.resolved_at
          ? 'this anomaly is already resolved'
          : 'only a refused amount on a capture, a refund or a payout that is still pending can be accepted, and anything else can only be disputed',
      )
    }
    const attempt = await this.#attempt(row.attempt_id!)
    const reply = await this.#psp.pull(attempt.id)
    if (reply.kind === 'unknown') throw pspUnavailable(reply.reason)
    if (reply.kind === 'none') throw refuse('the bank has no record of this operation')
    const said = (reply.body as { amount?: unknown }).amount
    if (!Number.isSafeInteger(said) || (said as number) <= 0) throw refuse('the bank did not say an amount')
    const amount = BigInt(said as number)
    if (amount > BigInt(attempt.amount)) throw refuse(`the bank says ${amount}, more than the ${attempt.amount} that was asked`)
    const call = await this.#attempts.callFor(attempt)
    const check = checkAnswer({ attemptId: call.attemptId, kind: call.kind, amount, currency: call.currency, chargeId: call.chargeId }, reply.body)
    if (!check.ok) throw refuse(`the bank's answer differs in more than the amount: ${check.problems.join('. ')}`)
    if (check.answer.status !== 'succeeded') throw refuse('the bank declined this operation, so there is no amount to accept')
    await this.#db.transaction(async (client) => {
      const locked = await client.query('SELECT 1 FROM anomalies WHERE id = $1 AND resolved_at IS NULL FOR UPDATE', [id])
      if (locked.rowCount !== 1) throw refuse('this anomaly is already resolved')
      const moved = await client.query(`UPDATE attempts SET amount = $2 WHERE id = $1 AND status = 'pending'`, [attempt.id, amount])
      if (moved.rowCount !== 1) throw refuse('the attempt is no longer pending')
      if (attempt.kind === 'refund') {
        await client.query(`UPDATE refunds SET amount = $2 WHERE id = $1 AND status = 'pending'`, [attempt.refund_id, amount])
      }
      if (attempt.kind === 'payout') await this.#adjustPayout(client, attempt.payout_id!, amount)
      const applied = await this.#attempts.apply(client, attempt.id, check.answer)
      if (applied !== 'applied') throw refuse(`the answer could not be applied (${applied})`)
      await client.query(`UPDATE anomalies SET resolution = 'accepted', resolved_at = now(), resolved_by = $2 WHERE id = $1`, [id, request.client.id])
    })
    return view(await this.#find(id))
  }

  @Post(':id/dispute')
  @HttpCode(200)
  async dispute(@Req() request: AuthedRequest, @Param('id', ParseIntPipe) id: number) {
    await this.#find(id)
    const { rowCount } = await this.#db.pool.query(
      `UPDATE anomalies SET resolution = 'disputed', resolved_at = now(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL`,
      [id, request.client.id],
    )
    if (rowCount !== 1) throw refuse('this anomaly is already resolved')
    return view(await this.#find(id))
  }

  async #adjustPayout(client: pg.PoolClient, payoutId: string, amount: bigint): Promise<void> {
    const payout = (await loadPayout(client, payoutId, true))!
    if (payout.status !== 'pending') throw refuse('the payout is no longer pending')
    const difference = BigInt(payout.amount) - amount
    if (difference <= 0n) return
    const bank = this.#chart.accounts(payout.currency).bank
    const journalId = await postInTransaction(client, this.#chart.registry, {
      externalRef: `payout-adjustment:${payout.id}`,
      entries: [
        { accountId: BigInt(payout.merchant_account_id), amount: -difference },
        { accountId: bank.id, amount: difference },
      ],
    })
    await client.query(`UPDATE payouts SET amount = $2, adjustment_journal_id = $3 WHERE id = $1 AND status = 'pending'`, [payout.id, amount, journalId])
    await journalEvents(client, journalId)
  }

  async #find(id: number): Promise<AnomalyRow> {
    const { rows } = await this.#db.pool.query<AnomalyRow>(`${SELECT} WHERE an.id = $1`, [id])
    if (!rows[0]) throw new ApiError(404, 'not_found', `no anomaly ${id}`)
    return rows[0]
  }

  async #attempt(id: string): Promise<AttemptRecord> {
    return firstRow(await this.#db.pool.query<AttemptRecord>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id = $1`, [id]))
  }
}
