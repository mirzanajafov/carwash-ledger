import { describe, expect, it } from 'vitest'
import { checkAnswer, type ExpectedAnswer } from '../src/psp/answers.ts'

describe('checking what the bank answered', () => {
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
