import { createHmac } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { TokenBuckets } from '../src/auth/token-buckets.ts'
import { dayTotals } from '../src/consumers/statements.ts'
import { databaseUnavailable } from '../src/db/unavailable.ts'
import { feeRefund, platformFee } from '../src/payments/fees.ts'
import { resolveCardAttempt } from '../src/payments/payment-state.ts'
import { checkAnswer, type ExpectedAnswer } from '../src/psp/answers.ts'
import { verifySignature } from '../src/webhooks/signature.ts'

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

describe('databaseUnavailable', () => {
  function failure(message: string, code?: string): Error {
    return Object.assign(new Error(message), code === undefined ? {} : { code })
  }

  it('recognises a database that is down, restarting, cut off or out of connections, and nothing else', () => {
    expect(databaseUnavailable(failure('connect ECONNREFUSED 127.0.0.1:6432', 'ECONNREFUSED'))).toBe(true)
    expect(databaseUnavailable(failure('read ECONNRESET', 'ECONNRESET'))).toBe(true)
    expect(databaseUnavailable(failure('Connection terminated unexpectedly'))).toBe(true)
    expect(databaseUnavailable(failure('timeout exceeded when trying to connect'))).toBe(true)
    expect(databaseUnavailable(failure('Query read timeout'))).toBe(true)
    expect(databaseUnavailable(failure('the database system is not yet accepting connections', '57P03'))).toBe(true)
    expect(databaseUnavailable(failure('terminating connection due to administrator command', '57P01'))).toBe(true)
    expect(databaseUnavailable(failure('terminating connection due to transaction timeout', '25P04'))).toBe(true)
    expect(databaseUnavailable(failure('connection failure', '08006'))).toBe(true)
    expect(databaseUnavailable(failure('duplicate key value violates unique constraint', '23505'))).toBe(false)
    expect(databaseUnavailable(failure('journal does not balance', 'P0001'))).toBe(false)
    expect(databaseUnavailable(failure('fetch failed'))).toBe(false)
    expect(databaseUnavailable('Connection terminated')).toBe(false)
  })
})

describe('dayTotals', () => {
  const entry = (account: string, amount: string, at: string) => ({ account_id: account === 'merchant_payable:a' ? '7' : '9', account, amount, posted_at: at })

  it('adds up merchant entries per account and UTC day, debits and credits apart, and skips other accounts', () => {
    expect(
      dayTotals([
        entry('merchant_payable:a', '-1460', '2026-10-13T23:59:59.900+02:00'),
        entry('merchant_payable:a', '500', '2026-10-13T21:00:00Z'),
        entry('merchant_payable:a', '-900', '2026-10-14T00:00:00Z'),
        entry('psp_receivable:EUR', '1500', '2026-10-13T12:00:00Z'),
      ]),
    ).toEqual([
      { accountId: '7', day: '2026-10-13', debits: 500n, credits: 1460n, entries: 2 },
      { accountId: '7', day: '2026-10-14', debits: 0n, credits: 900n, entries: 1 },
    ])
  })
})

describe('webhook signatures', () => {
  const body = '{"id":"evt_1"}'
  const at = 1_700_000_000
  const header = `t=${at},v1=${createHmac('sha256', 'whsec').update(`${at}.${body}`).digest('hex')}`

  it('accepts the PSP scheme inside five minutes and nothing else', () => {
    expect(verifySignature('whsec', body, header, at + 299)).toBe(true)
    expect(verifySignature('whsec', body, header, at + 301)).toBe(false)
    expect(verifySignature('whsec', `${body} `, header, at)).toBe(false)
    expect(verifySignature('other', body, header, at)).toBe(false)
    expect(verifySignature('whsec', body, header.slice(header.indexOf('v1=')), at)).toBe(false)
    expect(verifySignature('whsec', body, `t=${at},v1=zz`, at)).toBe(false)
    expect(verifySignature('whsec', body, '', at)).toBe(false)
  })
})
