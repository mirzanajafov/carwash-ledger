import { setTimeout as sleep } from 'node:timers/promises'
import type { Answer, Clients, RequestRecord } from './client.ts'
import type { PaymentJourney, PlannedPayout } from './plan.ts'

export interface PaymentBelief {
  journey: number
  paymentId: string
  status: string
  captured: number
  refunded: number
  refunds: { id: string; amount: number }[]
}

export interface PayoutBelief {
  index: number
  payoutId: string
  status: string
  amount: number
}

const EXAMPLES = 5

export class Journeys {
  readonly payments: PaymentBelief[] = []
  readonly payouts: PayoutBelief[] = []
  readonly refused: RequestRecord[] = []
  readonly outcomes: Record<string, number> = {}
  readonly payoutOutcomes: Record<string, number> = {}
  readonly surprises = { count: 0, examples: [] as string[] }
  readonly probes: Promise<unknown>[] = []
  readonly #clients: Clients
  readonly #merchants: readonly string[]
  readonly #callers: readonly string[]

  constructor(clients: Clients, merchants: readonly string[], callers: readonly string[]) {
    this.#clients = clients
    this.#merchants = merchants
    this.#callers = callers
  }

  learnAccepted(anomaly: {
    attempt: { kind: string; amount: string } | null
    payment_id: string | null
    refund_id: string | null
    payout_id: string | null
  }): void {
    if (!anomaly.attempt) return
    const amount = Number(anomaly.attempt.amount)
    if (anomaly.attempt.kind === 'payout') {
      const payout = this.payouts.find((p) => p.payoutId === anomaly.payout_id)
      if (payout) {
        payout.status = 'succeeded'
        payout.amount = amount
      }
      return
    }
    const belief = this.payments.find((p) => p.paymentId === anomaly.payment_id)
    if (!belief) return
    if (anomaly.attempt.kind === 'capture') {
      belief.status = 'captured'
      belief.captured = amount
    } else if (anomaly.attempt.kind === 'refund' && anomaly.refund_id) {
      belief.refunds.push({ id: anomaly.refund_id, amount })
      belief.refunded += amount
      if (belief.refunded === belief.captured) belief.status = 'refunded'
    }
  }

  async payment(journey: PaymentJourney): Promise<void> {
    const outcome = await this.#payment(journey)
    this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1
  }

  async payout(planned: PlannedPayout): Promise<void> {
    const outcome = await this.#payout(planned)
    this.payoutOutcomes[outcome] = (this.payoutOutcomes[outcome] ?? 0) + 1
  }

  #surprise(request: RequestRecord, answer: Answer): string {
    this.surprises.count++
    if (this.surprises.examples.length < EXAMPLES) {
      this.surprises.examples.push(`${request.kind} ${request.path} with ${request.key} got ${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`)
    }
    return 'unexpected'
  }

  async #send(caller: string, kind: RequestRecord['kind'], path: string, body: Record<string, unknown>, duplicate: boolean) {
    const request = this.#clients.record(caller, kind, path, body)
    const answer = await this.#clients.send(request, duplicate)
    if (answer?.verdict === 'refused') this.refused.push(request)
    return { request, answer }
  }

  async #payment(journey: PaymentJourney): Promise<string> {
    const caller = this.#callers[journey.client]!
    const body = {
      amount: journey.amount,
      currency: 'EUR',
      merchant: this.#merchants[journey.merchant]!,
      token: 'tok_ok',
      capture: journey.capture,
    }
    const created = await this.#send(caller, 'create', '/v1/payments', body, journey.duplicate)
    if (created.answer === undefined) return 'stopped'
    if (created.answer.verdict === 'refused') return 'refused'
    if (created.answer.status === 402 && created.answer.body?.payment?.status === 'failed') {
      this.payments.push({ journey: journey.index, paymentId: created.answer.body.payment.id, status: 'failed', captured: 0, refunded: 0, refunds: [] })
      return 'declined'
    }
    const expected = journey.capture === 'auto' ? 'captured' : 'authorized'
    if (created.answer.status !== 200 || created.answer.body.status !== expected) return this.#surprise(created.request, created.answer)
    const payment = created.answer.body
    const belief: PaymentBelief = {
      journey: journey.index,
      paymentId: payment.id,
      status: payment.status,
      captured: payment.captured_amount,
      refunded: 0,
      refunds: [],
    }
    this.payments.push(belief)
    if (journey.reuse) this.probes.push(this.#probe(created.request, { ...body, amount: journey.amount + 1 }))

    if (journey.capture === 'manual') {
      await sleep(journey.pauses[0]!)
      if (journey.settle === 'cancel') {
        const cancel = await this.#send(caller, 'cancel', `/v1/payments/${payment.id}/cancel`, {}, journey.duplicate)
        if (cancel.answer === undefined) return 'stopped'
        if (cancel.answer.verdict === 'refused') return 'refused'
        if (cancel.answer.status !== 200 || cancel.answer.body.status !== 'canceled') return this.#surprise(cancel.request, cancel.answer)
        belief.status = 'canceled'
        return 'canceled'
      }
      const captureBody = journey.captureAmount === journey.amount ? {} : { amount: journey.captureAmount }
      const path = `/v1/payments/${payment.id}/capture`
      const sent = await Promise.all(
        Array.from({ length: journey.rival ? 2 : 1 }, () => this.#send(caller, 'capture', path, captureBody, journey.duplicate)),
      )
      if (sent.some((s) => s.answer === undefined)) return 'stopped'
      const won = sent.filter((s) => s.answer!.status === 200)
      const lost = sent.filter((s) => s.answer!.status !== 200)
      if (won.length === 0) {
        if (lost.some((s) => s.answer!.verdict === 'refused')) return 'refused'
        return this.#surprise(lost[0]!.request, lost[0]!.answer!)
      }
      const winner = won[0]!.answer!
      if (winner.body.status !== 'captured' || winner.body.captured_amount !== journey.captureAmount) {
        return this.#surprise(won[0]!.request, winner)
      }
      if (won.length > 1) this.#surprise(won[1]!.request, won[1]!.answer!)
      for (const loser of lost) {
        if (loser.answer!.body?.error?.code !== 'payment_not_capturable') this.#surprise(loser.request, loser.answer!)
      }
      belief.status = 'captured'
      belief.captured = winner.body.captured_amount
    }

    for (let i = 0; i < journey.refunds.length; i++) {
      await sleep(journey.pauses[i + 1]!)
      const amount = journey.refunds[i]!
      const refund = await this.#send(caller, 'refund', `/v1/payments/${payment.id}/refunds`, { amount }, journey.duplicate)
      if (refund.answer === undefined) return 'stopped'
      if (refund.answer.verdict === 'refused') return 'refused'
      if (refund.answer.status !== 200 || refund.answer.body.status !== 'succeeded') return this.#surprise(refund.request, refund.answer)
      belief.refunds.push({ id: refund.answer.body.id, amount })
      belief.refunded += amount
      if (belief.refunded === belief.captured) belief.status = 'refunded'
    }
    if (belief.status === 'refunded') return 'refunded'
    return belief.refunded > 0 ? 'part refunded' : 'captured'
  }

  async #payout(planned: PlannedPayout): Promise<string> {
    const merchant = this.#merchants[planned.merchant]!
    const { request, answer } = await this.#send('admin', 'payout', '/v1/payouts', { merchant, currency: 'EUR' }, planned.duplicate)
    if (answer === undefined) return 'stopped'
    if (answer.verdict === 'refused') return 'refused'
    if (answer.status === 409 && answer.body?.error?.code === 'nothing_to_pay_out') return 'nothing to pay out'
    if (answer.status !== 200 || !['succeeded', 'failed'].includes(answer.body.status)) return this.#surprise(request, answer)
    this.payouts.push({ index: planned.index, payoutId: answer.body.id, status: answer.body.status, amount: answer.body.amount })
    return answer.body.status
  }

  async #probe(original: RequestRecord, body: Record<string, unknown>): Promise<void> {
    await sleep(100)
    const probe = this.#clients.record(original.caller, 'probe', original.path, body, original.key)
    await this.#clients.send(probe)
  }
}
