import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { TokenBuckets } from '../src/auth/token-buckets.ts'
import { canonicalJson, requestHash } from '../src/idempotency/request-hash.ts'
import { feeRefund, platformFee } from '../src/payments/fees.ts'
import { canMove, isFinal, resolveCardAttempt } from '../src/payments/payment-state.ts'
import { checkAnswer, type ExpectedAnswer } from '../src/psp/answers.ts'

describe('fees', () => {
  it('charges 2% plus 10 cents on the design doc example', () => {
    expect(platformFee(1500n, { bps: 200, fixed: 10n })).toBe(40n)
  })

  it('gives back exactly the whole fee over any split of a full refund, never more than each refund', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 11n, max: 10_000_000n }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 12 }),
        (captured, weights) => {
          const fee = platformFee(captured, { bps: 200, fixed: 10n })
          fc.pre(fee < captured)
          const total = weights.reduce((sum, w) => sum + w, 0)
          let left = captured
          const parts = weights.map((w, i) => {
            const part = i === weights.length - 1 ? left : (captured * BigInt(w)) / BigInt(total)
            left -= part
            return part
          })
          let refunded = 0n
          let returned = 0n
          for (const part of parts.filter((p) => p > 0n)) {
            const back = feeRefund(fee, captured, refunded, part)
            expect(back).toBeGreaterThanOrEqual(0n)
            expect(back).toBeLessThanOrEqual(part)
            refunded += part
            returned += back
          }
          expect(refunded).toBe(captured)
          expect(returned).toBe(fee)
        },
      ),
    )
  })
})

describe('payment state', () => {
  it('only moves forward along the documented edges', () => {
    expect(canMove('created', 'authorized')).toBe(true)
    expect(canMove('authorized', 'captured')).toBe(true)
    expect(canMove('captured', 'refunded')).toBe(true)
    expect(canMove('captured', 'authorized')).toBe(false)
    expect(canMove('created', 'captured')).toBe(false)
    expect(canMove('failed', 'authorized')).toBe(false)
    expect(['refunded', 'canceled', 'failed'].every((s) => isFinal(s as never))).toBe(true)
  })

  it('turns a PSP answer into a move, or into an anomaly when it does not fit', () => {
    expect(resolveCardAttempt('created', 'authorize', 'succeeded', null)).toEqual({ kind: 'move', from: 'created', to: 'authorized' })
    expect(resolveCardAttempt('created', 'authorize', 'declined', 'card_declined')).toEqual({ kind: 'move', from: 'created', to: 'failed' })
    expect(resolveCardAttempt('authorized', 'capture', 'declined', 'authorization_expired')).toEqual({
      kind: 'move',
      from: 'authorized',
      to: 'failed',
    })
    expect(resolveCardAttempt('authorized', 'capture', 'declined', 'charge_already_captured').kind).toBe('anomaly')
    expect(resolveCardAttempt('captured', 'capture', 'succeeded', null).kind).toBe('anomaly')
    expect(resolveCardAttempt('authorized', 'cancel', 'succeeded', null)).toEqual({ kind: 'move', from: 'authorized', to: 'canceled' })
  })
})

describe('checkAnswer', () => {
  const expected: ExpectedAnswer = { attemptId: 'att-1', kind: 'capture', amount: 1500n, currency: 'EUR', chargeId: 'ch_1' }
  const answer = {
    id: 'op_1',
    object: 'operation',
    idempotency_key: 'att-1',
    kind: 'capture',
    status: 'succeeded',
    reason: null,
    amount: 1500,
    currency: 'EUR',
    charge: { id: 'ch_1', authorized_amount: 1500 },
  }

  it('accepts an answer to exactly what was asked', () => {
    expect(checkAnswer(expected, answer)).toEqual({
      ok: true,
      answer: { operationId: 'op_1', status: 'succeeded', reason: null, chargeId: 'ch_1' },
    })
  })

  it('refuses a different amount, currency, key, kind or charge', () => {
    const problems = (patch: Record<string, unknown>) => {
      const result = checkAnswer(expected, { ...answer, ...patch })
      return result.ok ? [] : result.problems
    }
    expect(problems({ amount: 1499 })).toEqual(['amount is 1499, expected 1500'])
    expect(problems({ currency: 'USD' })).toEqual([expect.stringContaining('currency')])
    expect(problems({ idempotency_key: 'att-2' })).toEqual([expect.stringContaining('idempotency_key')])
    expect(problems({ kind: 'refund' })).toEqual([expect.stringContaining('kind')])
    expect(problems({ charge: { id: 'ch_2' } })).toEqual([expect.stringContaining('charge.id')])
    expect(problems({ status: 'maybe' })).toEqual([expect.stringContaining('status')])
    expect(problems({ amount: 1499.5 })).toEqual(['amount is 1499.5, expected 1500'])
    expect(checkAnswer(expected, 'not json').ok).toBe(false)
  })
})

describe('request hashing', () => {
  it('ignores key order but not values or the path', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}')
    const hash = requestHash('POST', '/v1/payments', { amount: 1, currency: 'EUR' })
    expect(requestHash('POST', '/v1/payments', { currency: 'EUR', amount: 1 }).equals(hash)).toBe(true)
    expect(requestHash('POST', '/v1/payments', { currency: 'EUR', amount: 2 }).equals(hash)).toBe(false)
    expect(requestHash('POST', '/v1/payouts', { currency: 'EUR', amount: 1 }).equals(hash)).toBe(false)
  })
})

describe('TokenBuckets', () => {
  it('allows a burst, then the rate, per key', () => {
    let now = 0
    const buckets = new TokenBuckets(10, 20, () => now)
    expect(Array.from({ length: 25 }, () => buckets.take('a')).filter(Boolean)).toHaveLength(20)
    expect(buckets.take('b')).toBe(true)
    now = 500
    expect(Array.from({ length: 10 }, () => buckets.take('a')).filter(Boolean)).toHaveLength(5)
  })
})
