import { Injectable } from '@nestjs/common'
import { failpoint } from '@carwash/failpoints'
import { postInTransaction, reversalOf, type EntryInput } from '@carwash/ledger'
import type { Transaction } from '@carwash/pg'
import { Database } from '../db/database.ts'
import { journalEvents, paymentEvent, refundEvent } from '../events/events.ts'
import type { AttemptId, PaymentId } from '../ids.ts'
import { Chart } from '../ledger/chart.service.ts'
import { failPayout, loadPayout, lockPayout, succeedPayout } from '../payouts/payouts.repository.ts'
import { checkAnswer, expectedFrom, type PspAnswer } from '../psp/answers.ts'
import { PspClient, type PspCall } from '../psp/psp.client.ts'
import { PspAnswerRejectedError, pspUnavailable } from '../psp/psp.errors.ts'
import { recordAnomaly } from './anomalies.repository.ts'
import type { Attempt, PayoutAttempt, RefundAttempt } from './attempt.ts'
import { attemptOutcome, insertAttempt, loadAttempt, resolveAttempt } from './attempts.repository.ts'
import { feeRefund, platformFee } from './fees.ts'
import type { Payment, PaymentStatus } from './payment.ts'
import { resolveCardAttempt } from './payment-state.ts'
import { failRefund, loadPayment, lockPayment, lockRefund, movePayment, setPaymentRefunded, succeedRefund, type PaymentChanges } from './payments.repository.ts'

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

  async settle(attempt: Attempt): Promise<Applied> {
    const call = await this.callFor(attempt)
    const reply = await this.#psp.send(call)
    if (reply.kind === 'unknown') throw pspUnavailable(reply.reason)
    failpoint('attempt.after_psp')
    return this.receive(call, reply.body)
  }

  async receive(call: PspCall, body: unknown): Promise<Applied> {
    const check = checkAnswer(expectedFrom(call), body)
    if (!check.ok) {
      await recordAnomaly(this.#db.pool, call.attemptId, 'answer_mismatch', { problems: check.problems, answer: body })
      throw new PspAnswerRejectedError()
    }
    return this.#db.transaction((client) => this.apply(client, call.attemptId, check.answer))
  }

  async apply(client: Transaction, attemptId: AttemptId, answer: PspAnswer): Promise<Applied> {
    const attempt = await loadAttempt(client, attemptId)
    if (attempt.kind === 'payout') return this.#applyPayout(client, attempt, answer)

    const payment = await lockPayment(client, attempt.paymentId)
    if (!(await this.#resolve(client, attempt, answer))) return 'already'
    if (attempt.kind === 'refund') return this.#applyRefund(client, attempt, payment, answer)

    const resolution = resolveCardAttempt(payment.status, attempt.kind, answer.status, answer.reason)
    if (resolution.kind === 'anomaly') {
      await recordAnomaly(client, attempt.id, 'unexpected_answer', { reason: resolution.reason, answer })
      return 'anomaly'
    }
    const { from, to } = resolution
    if (to === 'failed') {
      await this.#move(client, payment.id, from, to, { failureReason: answer.reason ?? 'declined' })
    } else if (attempt.kind === 'authorize') {
      await this.#move(client, payment.id, from, to, { pspChargeId: answer.chargeId })
      if (payment.captureMode === 'auto') {
        await insertAttempt(client, { kind: 'capture', paymentId: payment.id, amount: payment.amount, currency: payment.currency })
      }
    } else if (attempt.kind === 'capture') {
      const fee = platformFee(attempt.amount, this.#chart.feeSchedule)
      const accounts = this.#chart.accounts(payment.currency)
      const journalId = await postInTransaction(client, this.#chart.registry, {
        externalRef: `capture:${payment.id}`,
        entries: nonZero([
          { accountId: accounts.receivable.id, amount: attempt.amount },
          { accountId: payment.merchantAccountId, amount: -(attempt.amount - fee) },
          { accountId: accounts.fees.id, amount: -fee },
        ]),
      })
      await journalEvents(client, journalId)
      await this.#move(client, payment.id, from, to, { capturedAmount: attempt.amount, fee, captureJournalId: journalId })
    } else {
      await this.#move(client, payment.id, from, to, {})
    }
    return 'applied'
  }

  async #resolve(client: Transaction, attempt: Attempt, answer: PspAnswer): Promise<boolean> {
    if (await resolveAttempt(client, attempt.id, answer)) return true
    const current = await attemptOutcome(client, attempt.id)
    if (current.status !== answer.status || current.pspOperationId !== answer.operationId) {
      await recordAnomaly(client, attempt.id, 'answer_changed', { stored: { status: current.status, psp_operation_id: current.pspOperationId }, answer })
    }
    return false
  }

  async #move(client: Transaction, paymentId: PaymentId, from: PaymentStatus, to: PaymentStatus, changes: PaymentChanges): Promise<void> {
    if (!(await movePayment(client, paymentId, from, to, changes))) throw new Error(`payment ${paymentId} was not ${from} when it should have moved to ${to}`)
    await paymentEvent(client, paymentId)
  }

  async #applyRefund(client: Transaction, attempt: RefundAttempt, payment: Payment, answer: PspAnswer): Promise<Applied> {
    const { refundId } = attempt
    await lockRefund(client, refundId)
    if (answer.status === 'declined') {
      await failRefund(client, refundId, answer.reason ?? 'declined')
      await refundEvent(client, refundId)
      await recordAnomaly(client, attempt.id, 'refund_declined', { answer })
      return 'anomaly'
    }
    const captured = payment.capturedAmount
    const before = payment.refundedAmount
    const amount = attempt.amount
    if (payment.status !== 'captured' || before + amount > captured) {
      throw new Error(`refund ${refundId} does not fit payment ${payment.id} (${payment.status}, ${before} + ${amount} of ${captured})`)
    }
    const back = feeRefund(payment.fee, captured, before, amount)
    const accounts = this.#chart.accounts(payment.currency)
    const journalId = await postInTransaction(client, this.#chart.registry, {
      externalRef: `refund:${refundId}`,
      entries: nonZero([
        { accountId: accounts.receivable.id, amount: -amount },
        { accountId: payment.merchantAccountId, amount: amount - back },
        { accountId: accounts.fees.id, amount: back },
      ]),
    })
    await succeedRefund(client, refundId, back, journalId)
    await journalEvents(client, journalId)
    await refundEvent(client, refundId)
    const after = before + amount
    if (after === captured) {
      await this.#move(client, payment.id, 'captured', 'refunded', { refundedAmount: after })
    } else {
      await setPaymentRefunded(client, payment.id, after)
    }
    return 'applied'
  }

  async #applyPayout(client: Transaction, attempt: PayoutAttempt, answer: PspAnswer): Promise<Applied> {
    const payout = await lockPayout(client, attempt.payoutId)
    if (!(await this.#resolve(client, attempt, answer))) return 'already'
    if (answer.status === 'succeeded') {
      await succeedPayout(client, payout.id)
      return 'applied'
    }
    const reversal = await reversalOf(client, payout.journalId, `payout-reversal:${payout.id}`)
    const reversalId = await postInTransaction(client, this.#chart.registry, reversal)
    await journalEvents(client, reversalId)
    await failPayout(client, payout.id, answer.reason ?? 'declined', reversalId)
    return 'applied'
  }

  async callFor(attempt: Attempt): Promise<PspCall> {
    const base = { attemptId: attempt.id, amount: attempt.amount, currency: attempt.currency }
    if (attempt.kind === 'payout') {
      const payout = await loadPayout(this.#db.pool, attempt.payoutId)
      return { ...base, kind: 'payout', destination: payout.merchantCode }
    }
    const payment = await loadPayment(this.#db.pool, attempt.paymentId)
    if (attempt.kind === 'authorize') return { ...base, kind: 'authorize', token: payment.token }
    if (payment.pspChargeId === null) throw new Error(`payment ${payment.id} has no PSP charge to ${attempt.kind}`)
    return { ...base, kind: attempt.kind, chargeId: payment.pspChargeId }
  }
}
