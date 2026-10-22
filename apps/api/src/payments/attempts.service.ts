import { Injectable } from '@nestjs/common'
import { failpoint } from '@carwash/failpoints'
import { postInTransaction, reversalOf, type EntryInput } from '@carwash/ledger'
import type pg from 'pg'
import { Database } from '../db/database.ts'
import { journalEvents, paymentEvent, refundEvent } from '../events/events.ts'
import { PspAnswerRejectedError, pspUnavailable } from '../domain-errors.ts'
import { Chart } from '../ledger/chart.service.ts'
import { failPayout, loadPayout, lockPayout, succeedPayout } from '../payouts/payouts.repository.ts'
import { checkAnswer, type ExpectedAnswer, type PspAnswer } from '../psp/answers.ts'
import { PspClient, type PspCall } from '../psp/psp.client.ts'
import { recordAnomaly } from './anomalies.repository.ts'
import { attemptOutcome, insertAttempt, loadAttempt, resolveAttempt, type AttemptRecord } from './attempts.repository.ts'
import { feeRefund, platformFee } from './fees.ts'
import { resolveCardAttempt, type PaymentStatus } from './payment-state.ts'
import {
  failRefund,
  loadPayment,
  lockPayment,
  lockRefund,
  movePayment,
  setPaymentRefunded,
  succeedRefund,
  type PaymentChanges,
  type PaymentRecord,
} from './payments.repository.ts'

export type Applied = 'applied' | 'already' | 'anomaly'

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
    failpoint('attempt.after_psp')
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
      throw new PspAnswerRejectedError()
    }
    return this.#db.transaction((client) => this.apply(client, call.attemptId, check.answer))
  }

  async apply(client: pg.ClientBase, attemptId: string, answer: PspAnswer): Promise<Applied> {
    const attempt = await loadAttempt(client, attemptId)
    if (!attempt) throw new Error(`attempt ${attemptId} does not exist`)
    if (attempt.kind === 'payout') return this.#applyPayout(client, attempt, answer)

    const payment = (await lockPayment(client, attempt.payment_id!))!
    if (!(await this.#resolve(client, attempt, answer))) return 'already'
    if (attempt.kind === 'refund') return this.#applyRefund(client, attempt, payment, answer)

    const resolution = resolveCardAttempt(payment.status, attempt.kind, answer.status, answer.reason)
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
        await insertAttempt(client, { kind: 'capture', paymentId: payment.id, amount: BigInt(payment.amount), currency: payment.currency })
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
      await journalEvents(client, journalId)
      await this.#move(client, payment.id, from, to, { captured_amount: amount, fee, capture_journal_id: journalId })
    } else {
      await this.#move(client, payment.id, from, to, {})
    }
    return 'applied'
  }

  async #resolve(client: pg.ClientBase, attempt: AttemptRecord, answer: PspAnswer): Promise<boolean> {
    if (await resolveAttempt(client, attempt.id, answer)) return true
    const current = await attemptOutcome(client, attempt.id)
    if (current.status !== answer.status || current.psp_operation_id !== answer.operationId) {
      await recordAnomaly(client, attempt.id, 'answer_changed', { stored: current, answer })
    }
    return false
  }

  async #move(client: pg.ClientBase, paymentId: string, from: PaymentStatus, to: PaymentStatus, changes: PaymentChanges): Promise<void> {
    if (!(await movePayment(client, paymentId, from, to, changes))) throw new Error(`payment ${paymentId} was not ${from} when it should have moved to ${to}`)
    await paymentEvent(client, paymentId, `payment.${to}`)
  }

  async #applyRefund(client: pg.ClientBase, attempt: AttemptRecord, payment: PaymentRecord, answer: PspAnswer): Promise<Applied> {
    const refundId = attempt.refund_id!
    await lockRefund(client, refundId)
    if (answer.status === 'declined') {
      await failRefund(client, refundId, answer.reason ?? 'declined')
      await refundEvent(client, refundId, 'refund.failed')
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
    await succeedRefund(client, refundId, back, journalId)
    await journalEvents(client, journalId)
    await refundEvent(client, refundId, 'refund.succeeded')
    const after = before + amount
    if (after === captured) {
      await this.#move(client, payment.id, 'captured', 'refunded', { refunded_amount: after })
    } else {
      await setPaymentRefunded(client, payment.id, after)
    }
    return 'applied'
  }

  async #applyPayout(client: pg.ClientBase, attempt: AttemptRecord, answer: PspAnswer): Promise<Applied> {
    const payout = (await lockPayout(client, attempt.payout_id!))!
    if (!(await this.#resolve(client, attempt, answer))) return 'already'
    if (answer.status === 'succeeded') {
      await succeedPayout(client, payout.id)
      return 'applied'
    }
    const reversal = await reversalOf(client, BigInt(payout.journal_id!), `payout-reversal:${payout.id}`)
    const reversalId = await postInTransaction(client, this.#chart.registry, reversal)
    await journalEvents(client, reversalId)
    await failPayout(client, payout.id, answer.reason ?? 'declined', reversalId)
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
