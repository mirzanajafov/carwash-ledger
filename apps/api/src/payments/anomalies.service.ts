import { Injectable } from '@nestjs/common'
import { postInTransaction } from '@carwash/ledger'
import { writeJournalEvents } from '@carwash/outbox'
import type { Transaction } from '@carwash/pg'
import { Database } from '../db/database.ts'
import { DomainError } from '../domain-errors.ts'
import { asAttemptId, type PayoutId } from '../ids.ts'
import { ChartService } from '../ledger/chart.service.ts'
import { lockPayout, recordPayoutAdjustment } from '../payouts/payouts.repository.ts'
import { answeredAmount, checkAnswer, expectedFrom, type AttemptKind, type ExpectedAnswer, type PspAnswer } from '../psp/answers.ts'
import { PspClient } from '../psp/psp.client.ts'
import { pspUnavailable } from '../psp/psp.errors.ts'
import { findAnomaly, listAnomalies, resolveAnomaly, type AnomalyAttempt, type AnomalyRow } from './anomalies.repository.ts'
import { loadAttempt, setAttemptAmount } from './attempts.repository.ts'
import { AttemptsService } from './attempts.service.ts'
import { correctRefundAmount } from './payments.repository.ts'

const ACCEPTABLE: ReadonlySet<AttemptKind> = new Set(['capture', 'refund', 'payout'])

type Acceptance = { ok: true; amount: bigint; answer: PspAnswer } | { ok: false; reason: string }

function pendingMismatch(row: AnomalyRow): row is AnomalyRow & { attempt: AnomalyAttempt } {
  return row.kind === 'answer_mismatch' && row.resolved_at === null && row.attempt?.status === 'pending' && ACCEPTABLE.has(row.attempt.kind)
}

function acceptance(expected: ExpectedAnswer, body: unknown): Acceptance {
  const amount = answeredAmount(body)
  if (amount === undefined) return { ok: false, reason: 'the bank did not say an amount' }
  if (amount > expected.amount) return { ok: false, reason: `the bank says ${amount}, more than the ${expected.amount} that was asked` }
  const check = checkAnswer({ ...expected, amount }, body)
  if (!check.ok) return { ok: false, reason: `the bank's answer differs in more than the amount: ${check.problems.join('. ')}` }
  if (check.answer.status !== 'succeeded') return { ok: false, reason: 'the bank declined this operation, so there is no amount to accept' }
  return { ok: true, amount, answer: check.answer }
}

export function acceptable(row: AnomalyRow): boolean {
  if (!pendingMismatch(row)) return false
  const { id, kind, amount, currency } = row.attempt
  return acceptance({ attemptId: id, kind, amount: BigInt(amount), currency, chargeId: row.charge_id }, row.details?.answer).ok
}

function refuse(message: string): DomainError {
  return new DomainError('conflict', 'not_acceptable', message)
}

@Injectable()
export class AnomaliesService {
  readonly #db: Database
  readonly #attempts: AttemptsService
  readonly #psp: PspClient
  readonly #chart: ChartService

  constructor(db: Database, attempts: AttemptsService, psp: PspClient, chart: ChartService) {
    this.#db = db
    this.#attempts = attempts
    this.#psp = psp
    this.#chart = chart
  }

  list(open: boolean, limit: number): Promise<AnomalyRow[]> {
    return listAnomalies(this.#db.pool, open, limit)
  }

  async accept(id: number, clientId: string): Promise<AnomalyRow> {
    const row = await this.#find(id)
    if (!pendingMismatch(row)) {
      throw refuse(
        row.resolved_at
          ? 'this anomaly is already resolved'
          : 'only a refused amount on a capture, a refund or a payout that is still pending can be accepted, and anything else can only be disputed',
      )
    }
    const attempt = await loadAttempt(this.#db.pool, asAttemptId(row.attempt.id))
    const reply = await this.#psp.pull(attempt.id)
    if (reply.kind === 'unknown') throw pspUnavailable(reply.reason)
    if (reply.kind === 'none') throw refuse('the bank has no record of this operation')
    const accepted = acceptance(expectedFrom(await this.#attempts.callFor(attempt)), reply.body)
    if (!accepted.ok) throw refuse(accepted.reason)
    const { amount, answer } = accepted
    await this.#db.transaction(async (client) => {
      if (!(await resolveAnomaly(client, id, 'accepted', clientId))) throw refuse('this anomaly is already resolved')
      if (!(await setAttemptAmount(client, attempt.id, amount))) throw refuse('the attempt is no longer pending')
      if (attempt.kind === 'refund') await correctRefundAmount(client, attempt.refundId, amount)
      if (attempt.kind === 'payout') await this.#adjustPayout(client, attempt.payoutId, amount)
      const applied = await this.#attempts.apply(client, attempt.id, answer)
      if (applied !== 'applied') throw refuse(`the answer could not be applied (${applied})`)
    })
    return this.#find(id)
  }

  async dispute(id: number, clientId: string): Promise<AnomalyRow> {
    const resolved = await resolveAnomaly(this.#db.pool, id, 'disputed', clientId)
    const row = await this.#find(id)
    if (!resolved) throw refuse('this anomaly is already resolved')
    return row
  }

  async #adjustPayout(client: Transaction, payoutId: PayoutId, amount: bigint): Promise<void> {
    const payout = await lockPayout(client, payoutId)
    if (payout.status !== 'pending') throw refuse('the payout is no longer pending')
    const difference = payout.amount - amount
    if (difference <= 0n) return
    const bank = this.#chart.accounts(payout.currency).bank
    const journalId = await postInTransaction(client, this.#chart.registry, {
      externalRef: `payout-adjustment:${payout.id}`,
      entries: [
        { accountId: payout.merchantAccountId, amount: -difference },
        { accountId: bank.id, amount: difference },
      ],
    })
    await recordPayoutAdjustment(client, payout.id, amount, journalId)
    await writeJournalEvents(client, journalId)
  }

  async #find(id: number): Promise<AnomalyRow> {
    const row = await findAnomaly(this.#db.pool, id)
    if (!row) throw new DomainError('not_found', 'not_found', `no anomaly ${id}`)
    return row
  }
}
