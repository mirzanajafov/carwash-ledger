import { Injectable } from '@nestjs/common'
import { postInTransaction, reversalOf, type EntryInput } from '@carwash/ledger'
import type pg from 'pg'
import { Database } from '../db/database.ts'
import { ApiError } from '../http/api-error.ts'
import { Chart } from '../ledger/chart.service.ts'
import { checkAnswer, type ExpectedAnswer, type PspAnswer } from '../psp/answers.ts'
import { PspClient, type PspCall } from '../psp/psp.client.ts'
import { feeRefund, platformFee } from './fees.ts'
import { resolveCardAttempt, type CardAttemptKind, type PaymentStatus } from './payment-state.ts'
import { ATTEMPT_COLUMNS, loadPayment, loadPayout, type AttemptRecord, type PaymentRecord } from './records.ts'

export type Applied = 'applied' | 'already' | 'anomaly'

export function pspUnavailable(reason: string): ApiError {
  return new ApiError(503, 'psp_unavailable', `the PSP did not give an answer (${reason}); retry with the same idempotency key`, {
    'retry-after': '1',
  })
}

export async function recordAnomaly(db: pg.ClientBase | pg.Pool, attemptId: string | null, kind: string, details: unknown): Promise<void> {
  await db.query('INSERT INTO anomalies (attempt_id, kind, details) VALUES ($1, $2, $3) ON CONFLICT (attempt_id, kind) DO NOTHING', [
    attemptId,
    kind,
    JSON.stringify(details),
  ])
}

function nonZero(entries: EntryInput[]): EntryInput[] {
  return entries.filter((entry) => entry.amount !== 0n)
}

@Injectable()
export class AttemptsService {
  readonly #db: Database
  readonly #chart: Chart
  readonly #psp: PspClient

  constructor(db: Database, chart: Chart, psp: PspClient) {
    this.#db = db
    this.#chart = chart
    this.#psp = psp
  }

  async settle(attempt: AttemptRecord): Promise<Applied> {
    const call = await this.callFor(attempt)
    const reply = await this.#psp.send(call)
    if (reply.kind === 'unknown') throw pspUnavailable(reply.reason)
    return this.receive(call, reply.body)
  }

  async receive(call: PspCall, body: unknown): Promise<Applied> {
    const expected: ExpectedAnswer = {
      attemptId: call.attemptId,
      kind: call.kind,
      amount: call.amount,
      currency: call.currency,
      chargeId: call.chargeId,
    }
    const check = checkAnswer(expected, body)
    if (!check.ok) {
      await recordAnomaly(this.#db.pool, call.attemptId, 'answer_mismatch', { problems: check.problems, answer: body })
      throw new ApiError(502, 'psp_answer_rejected', 'the PSP answered something that does not match the request; it is recorded as an anomaly')
    }
    return this.#db.transaction((client) => this.apply(client, call.attemptId, check.answer))
  }

  async apply(client: pg.ClientBase, attemptId: string, answer: PspAnswer): Promise<Applied> {
    const { rows } = await client.query<AttemptRecord>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id = $1`, [attemptId])
    const attempt = rows[0]
    if (!attempt) throw new Error(`attempt ${attemptId} does not exist`)
    if (attempt.kind === 'payout') return this.#applyPayout(client, attempt, answer)

    const payment = (await loadPayment(client, attempt.payment_id!, true))!
    if (!(await this.#resolve(client, attempt, answer))) return 'already'
    if (attempt.kind === 'refund') return this.#applyRefund(client, attempt, payment, answer)

    const resolution = resolveCardAttempt(payment.status, attempt.kind as CardAttemptKind, answer.status, answer.reason)
    if (resolution.kind === 'anomaly') {
      await recordAnomaly(client, attempt.id, 'unexpected_answer', { reason: resolution.reason, answer })
      return 'anomaly'
    }
    const { from, to } = resolution
    if (to === 'failed') {
      await this.#move(client, payment.id, from, to, { failure_reason: answer.reason ?? 'declined' })
    } else if (attempt.kind === 'authorize') {
      await this.#move(client, payment.id, from, to, { psp_charge_id: answer.chargeId })
      if (payment.capture_mode === 'auto') {
        await client.query(`INSERT INTO attempts (kind, payment_id, amount, currency) VALUES ('capture', $1, $2, $3)`, [
          payment.id,
          payment.amount,
          payment.currency,
        ])
      }
    } else if (attempt.kind === 'capture') {
      const amount = BigInt(attempt.amount)
      const fee = platformFee(amount, this.#chart.feeSchedule)
      const accounts = this.#chart.accounts(payment.currency)
      const journalId = await postInTransaction(client, this.#chart.registry, {
        externalRef: `capture:${payment.id}`,
        entries: nonZero([
          { accountId: accounts.receivable.id, amount },
          { accountId: BigInt(payment.merchant_account_id), amount: -(amount - fee) },
          { accountId: accounts.fees.id, amount: -fee },
        ]),
      })
      await this.#move(client, payment.id, from, to, { captured_amount: amount, fee, capture_journal_id: journalId })
    } else {
      await this.#move(client, payment.id, from, to, {})
    }
    return 'applied'
  }

  async #resolve(client: pg.ClientBase, attempt: AttemptRecord, answer: PspAnswer): Promise<boolean> {
    const updated = await client.query(
      `UPDATE attempts SET status = $2::attempt_status, psp_operation_id = $3, decline_reason = $4, resolved_at = now()
       WHERE id = $1 AND status = 'pending'`,
      [attempt.id, answer.status, answer.operationId, answer.reason],
    )
    if (updated.rowCount === 1) return true
    const { rows } = await client.query<{ status: string; psp_operation_id: string | null }>(
      'SELECT status::text, psp_operation_id FROM attempts WHERE id = $1',
      [attempt.id],
    )
    const current = rows[0]!
    if (current.status !== answer.status || current.psp_operation_id !== answer.operationId) {
      await recordAnomaly(client, attempt.id, 'answer_changed', { stored: current, answer })
    }
    return false
  }

  async #move(client: pg.ClientBase, paymentId: string, from: PaymentStatus, to: PaymentStatus, set: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(set)
    const assignments = columns.map((column, index) => `, ${column} = $${index + 4}`).join('')
    const moved = await client.query(
      `UPDATE payments SET status = $3::payment_status, updated_at = now()${assignments}
       WHERE id = $1 AND status = $2::payment_status`,
      [paymentId, from, to, ...columns.map((column) => set[column])],
    )
    if (moved.rowCount !== 1) throw new Error(`payment ${paymentId} was not ${from} when it should have moved to ${to}`)
  }

  async #applyRefund(client: pg.ClientBase, attempt: AttemptRecord, payment: PaymentRecord, answer: PspAnswer): Promise<Applied> {
    const refundId = attempt.refund_id!
    await client.query('SELECT 1 FROM refunds WHERE id = $1 FOR UPDATE', [refundId])
    if (answer.status === 'declined') {
      await client.query(`UPDATE refunds SET status = 'failed', failure_reason = $2, resolved_at = now() WHERE id = $1 AND status = 'pending'`, [
        refundId,
        answer.reason ?? 'declined',
      ])
      await recordAnomaly(client, attempt.id, 'refund_declined', { answer })
      return 'anomaly'
    }
    const captured = BigInt(payment.captured_amount)
    const before = BigInt(payment.refunded_amount)
    const amount = BigInt(attempt.amount)
    if (payment.status !== 'captured' || before + amount > captured) {
      throw new Error(`refund ${refundId} does not fit payment ${payment.id} (${payment.status}, ${before} + ${amount} of ${captured})`)
    }
    const back = feeRefund(BigInt(payment.fee), captured, before, amount)
    const accounts = this.#chart.accounts(payment.currency)
    const journalId = await postInTransaction(client, this.#chart.registry, {
      externalRef: `refund:${refundId}`,
      entries: nonZero([
        { accountId: accounts.receivable.id, amount: -amount },
        { accountId: BigInt(payment.merchant_account_id), amount: amount - back },
        { accountId: accounts.fees.id, amount: back },
      ]),
    })
    await client.query(
      `UPDATE refunds SET status = 'succeeded', fee_refund = $2, journal_id = $3, resolved_at = now() WHERE id = $1 AND status = 'pending'`,
      [refundId, back, journalId],
    )
    const after = before + amount
    if (after === captured) {
      await this.#move(client, payment.id, 'captured', 'refunded', { refunded_amount: after })
    } else {
      await client.query(`UPDATE payments SET refunded_amount = $2, updated_at = now() WHERE id = $1 AND status = 'captured'`, [payment.id, after])
    }
    return 'applied'
  }

  async #applyPayout(client: pg.ClientBase, attempt: AttemptRecord, answer: PspAnswer): Promise<Applied> {
    const payout = (await loadPayout(client, attempt.payout_id!, true))!
    if (!(await this.#resolve(client, attempt, answer))) return 'already'
    if (answer.status === 'succeeded') {
      await client.query(`UPDATE payouts SET status = 'succeeded', resolved_at = now() WHERE id = $1 AND status = 'pending'`, [payout.id])
      return 'applied'
    }
    const reversal = await reversalOf(client, BigInt(payout.journal_id!), `payout-reversal:${payout.id}`)
    const reversalId = await postInTransaction(client, this.#chart.registry, reversal)
    await client.query(
      `UPDATE payouts SET status = 'failed', failure_reason = $2, reversal_journal_id = $3, resolved_at = now() WHERE id = $1 AND status = 'pending'`,
      [payout.id, answer.reason ?? 'declined', reversalId],
    )
    return 'applied'
  }

  async callFor(attempt: AttemptRecord): Promise<PspCall> {
    const base = { attemptId: attempt.id, kind: attempt.kind, amount: BigInt(attempt.amount), currency: attempt.currency }
    if (attempt.kind === 'payout') {
      const payout = (await loadPayout(this.#db.pool, attempt.payout_id!))!
      return { ...base, chargeId: null, token: null, destination: payout.merchant_code }
    }
    const payment = (await loadPayment(this.#db.pool, attempt.payment_id!))!
    return {
      ...base,
      chargeId: attempt.kind === 'authorize' ? null : payment.psp_charge_id,
      token: attempt.kind === 'authorize' ? payment.token : null,
      destination: null,
    }
  }
}
