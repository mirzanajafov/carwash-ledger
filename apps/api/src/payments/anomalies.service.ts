import { Injectable } from '@nestjs/common'
import { postInTransaction } from '@carwash/ledger'
import type pg from 'pg'
import { Database } from '../db/database.ts'
import { journalEvents } from '../events/events.ts'
import { ApiError } from '../http/api-error.ts'
import { Chart } from '../ledger/chart.service.ts'
import { lockPayout, recordPayoutAdjustment } from '../payouts/payouts.repository.ts'
import { checkAnswer } from '../psp/answers.ts'
import { PspClient } from '../psp/psp.client.ts'
import { findAnomaly, listAnomalies, resolveAnomaly, type AnomalyRow } from './anomalies.repository.ts'
import { loadAttempt, setAttemptAmount } from './attempts.repository.ts'
import { AttemptsService, pspUnavailable } from './attempts.service.ts'
import { correctRefundAmount } from './payments.repository.ts'

const ACCEPTABLE = new Set(['capture', 'refund', 'payout'])

export function acceptable(row: AnomalyRow): boolean {
  return row.kind === 'answer_mismatch' && row.resolved_at === null && row.attempt_status === 'pending' && ACCEPTABLE.has(row.attempt_kind ?? '')
}

function refuse(message: string): ApiError {
  return new ApiError(409, 'not_acceptable', message)
}

@Injectable()
export class AnomaliesService {
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

  list(open: boolean, limit: number): Promise<AnomalyRow[]> {
    return listAnomalies(this.#db.pool, open, limit)
  }

  async accept(id: number, clientId: string): Promise<AnomalyRow> {
    const row = await this.#find(id)
    if (!acceptable(row)) {
      throw refuse(
        row.resolved_at
          ? 'this anomaly is already resolved'
          : 'only a refused amount on a capture, a refund or a payout that is still pending can be accepted, and anything else can only be disputed',
      )
    }
    const attempt = await loadAttempt(this.#db.pool, row.attempt_id!)
    if (!attempt) throw new Error(`attempt ${row.attempt_id} does not exist`)
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
      if (!(await resolveAnomaly(client, id, 'accepted', clientId))) throw refuse('this anomaly is already resolved')
      if (!(await setAttemptAmount(client, attempt.id, amount))) throw refuse('the attempt is no longer pending')
      if (attempt.kind === 'refund') await correctRefundAmount(client, attempt.refund_id!, amount)
      if (attempt.kind === 'payout') await this.#adjustPayout(client, attempt.payout_id!, amount)
      const applied = await this.#attempts.apply(client, attempt.id, check.answer)
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

  async #adjustPayout(client: pg.ClientBase, payoutId: string, amount: bigint): Promise<void> {
    const payout = (await lockPayout(client, payoutId))!
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
    await recordPayoutAdjustment(client, payout.id, amount, journalId)
    await journalEvents(client, journalId)
  }

  async #find(id: number): Promise<AnomalyRow> {
    const row = await findAnomaly(this.#db.pool, id)
    if (!row) throw new ApiError(404, 'not_found', `no anomaly ${id}`)
    return row
  }
}
