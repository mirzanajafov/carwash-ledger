import { describe, expect, it } from 'vitest'
import { checkKeys, compareBeliefs, unanswered, type LedgerState } from '../src/payments/checks.ts'
import { backoff, canonical, verdictOf, type RequestRecord } from '../src/payments/client.ts'
import type { PaymentBelief } from '../src/payments/journeys.ts'

function request(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return { key: 'k1', caller: 'client-0', kind: 'create', path: '/v1/payments', body: {}, sends: 1, stored: [], ...overrides }
}

function state(overrides: Partial<LedgerState> = {}): LedgerState {
  return { payments: new Map(), refunds: new Map(), payouts: new Map(), anomalous: new Set(), ...overrides }
}

describe('the client', () => {
  it('retries what may not have happened and stops at what was stored or refused', () => {
    expect(verdictOf(200, {})).toBe('stored')
    expect(verdictOf(402, {})).toBe('stored')
    expect(verdictOf(502, {})).toBe('refused')
    expect(verdictOf(503, {})).toBe('retry')
    expect(verdictOf(500, {})).toBe('retry')
    expect(verdictOf(409, { error: { code: 'request_in_progress' } })).toBe('retry')
    expect(verdictOf(409, { error: { code: 'payment_not_capturable' } })).toBe('rejected')
    expect(verdictOf(422, {})).toBe('rejected')
  })

  it('backs off exponentially up to two seconds and never sooner than Retry-After', () => {
    expect(backoff(() => 0.999, 0)).toBeLessThanOrEqual(50)
    expect(backoff(() => 0.999, 10)).toBeGreaterThan(1990)
    expect(backoff(() => 0.999, 10)).toBeLessThanOrEqual(2000)
    expect(backoff(() => 0, 0, 1)).toBe(1000)
  })

  it('compares answers whatever order their keys come back in', () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonical({ a: [{ c: 3, d: 2 }], b: 1 }))
  })
})

describe('the key checks', () => {
  it('flag a key answered two ways, and a reused key that was not refused', () => {
    const same = request({ stored: ['200 {"a":1}', '200 {"a":1}'] })
    const split = request({ key: 'k2', stored: ['200 {"a":1}', '200 {"a":2}'] })
    const refused = request({ key: 'k3', kind: 'probe', final: { status: 422, body: { error: { code: 'idempotency_key_reused' } }, verdict: 'rejected' } })
    const replayed = request({ key: 'k4', kind: 'probe', final: { status: 200, body: { id: 'p' }, verdict: 'stored' } })
    const found = checkKeys([same, split], [refused, replayed])
    expect(found.count).toBe(2)
    expect(found.examples[0]).toContain('k2')
    expect(found.examples[1]).toContain('k4')
  })

  it('flag every request still without an answer', () => {
    const answered = request({ final: { status: 200, body: {}, verdict: 'stored' } })
    expect(unanswered([answered, request({ key: 'k9', lastError: 'timeout' })], []).examples).toEqual([
      'create /v1/payments with k9 has no answer after 1 sends (timeout)',
    ])
  })
})

describe('compareBeliefs', () => {
  const belief: PaymentBelief = {
    journey: 1,
    paymentId: 'p1',
    status: 'refunded',
    captured: 1500,
    refunded: 1500,
    refunds: [{ id: 'r1', amount: 1500 }],
  }

  it('accepts a ledger that holds what the client was told', () => {
    const ledger = state({
      payments: new Map([['p1', { status: 'refunded', captured: 1500, refunded: 1500 }]]),
      refunds: new Map([['r1', { status: 'succeeded', amount: 1500 }]]),
      payouts: new Map([['po1', { status: 'failed', amount: 700 }]]),
      anomalous: new Set(['k1']),
    })
    const found = compareBeliefs([belief], [{ index: 0, payoutId: 'po1', status: 'failed', amount: 700 }], [request()], ledger)
    expect(found).toEqual({ count: 0, examples: [] })
  })

  it('flags a payment, refund or payout that differs, and a refusal without an anomaly', () => {
    const ledger = state({
      payments: new Map([['p1', { status: 'captured', captured: 1500, refunded: 0 }]]),
      refunds: new Map([['r1', { status: 'pending', amount: 1500 }]]),
    })
    const found = compareBeliefs([belief], [{ index: 0, payoutId: 'po1', status: 'succeeded', amount: 700 }], [request()], ledger)
    expect(found.count).toBe(4)
  })
})
