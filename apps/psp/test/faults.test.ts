import { describe, expect, it } from 'vitest'
import { Faults, NO_FAULTS, parseFaultPlan, parseToken } from '../src/faults.ts'

describe('parseToken', () => {
  it('reads every kind of test token and rejects anything else', () => {
    expect(parseToken('tok_ok')).toEqual({ kind: 'ok' })
    expect(parseToken('tok_decline')).toEqual({ kind: 'decline' })
    expect(parseToken('tok_fail_once_capture')).toEqual({ kind: 'fail_once', operation: 'capture' })
    expect(parseToken('tok_timeout_after_refund')).toEqual({ kind: 'timeout_after', operation: 'refund' })
    expect(parseToken('tok_drop_after_authorize')).toEqual({ kind: 'drop_after', operation: 'authorize' })
    expect(parseToken('tok_webhook_reorder')).toEqual({ kind: 'webhook', fault: 'reorder' })
    expect(parseToken('tok_fail_payout')).toBeUndefined()
    expect(parseToken('4242424242424242')).toBeUndefined()
  })
})

describe('Faults', () => {
  it('fails a fail_once operation only the first time its key is seen', () => {
    const faults = new Faults()
    const token = parseToken('tok_fail_once_capture')!
    expect(faults.behaviour('k1', 'capture', token).fail).toBe(true)
    expect(faults.behaviour('k1', 'capture', token).fail).toBe(false)
    expect(faults.behaviour('k2', 'capture', token).fail).toBe(true)
    expect(faults.behaviour('k3', 'refund', token).fail).toBe(false)
  })

  it('applies a token only to the operation it names', () => {
    const faults = new Faults()
    const token = parseToken('tok_timeout_after_capture')!
    expect(faults.behaviour('a', 'capture', token).afterCommit).toBe('hang')
    expect(faults.behaviour('b', 'authorize', token).afterCommit).toBe('answer')
    expect(faults.behaviour('c', 'authorize', parseToken('tok_decline')!).decline).toBe(true)
    expect(faults.behaviour('d', 'capture', parseToken('tok_decline')!).decline).toBe(false)
  })

  it('draws the same faults for the same seed and key whatever else was asked in between', () => {
    const plan = parseFaultPlan({ seed: 7, fail: 0.3, slow: 0.3, timeoutAfterCommit: 0.3, webhook: { duplicate: 0.3, drop: 0.3 } })
    const ok = parseToken('tok_ok')!
    const first = new Faults(plan)
    const second = new Faults(plan)
    for (let i = 0; i < 50; i++) second.behaviour(`noise-${i}`, 'authorize', ok)
    const keys = Array.from({ length: 200 }, (_, i) => `key-${i}`)
    const summary = (faults: Faults) =>
      keys.map((key) => {
        const b = faults.behaviour(key, 'capture', ok)
        return [b.fail, b.afterCommit, b.slowMs, [...b.webhook].join('+')].join('/')
      })
    const drawn = summary(first)
    expect(summary(second)).toEqual(drawn)
    const failed = drawn.filter((line) => line.startsWith('true')).length
    expect(failed).toBeGreaterThan(30)
    expect(failed).toBeLessThan(90)
    expect(new Set(drawn).size).toBeGreaterThan(5)
  })

  it('never injects anything without a plan or a token', () => {
    const faults = new Faults(NO_FAULTS)
    for (let i = 0; i < 100; i++) {
      const b = faults.behaviour(`k${i}`, 'authorize', { kind: 'ok' })
      expect([b.decline, b.fail, b.afterCommit, b.slowMs, b.webhook.size]).toEqual([false, false, 'answer', 0, 0])
    }
  })
})

describe('parseFaultPlan', () => {
  it('fills in zeros and rejects anything it does not understand', () => {
    expect(parseFaultPlan({ decline: 0.5 })).toEqual({ ...NO_FAULTS, decline: 0.5 })
    expect(() => parseFaultPlan({ decline: 1.5 })).toThrow('decline must be a probability')
    expect(() => parseFaultPlan({ timeout: 0.1 })).toThrow('unknown fault plan field timeout')
    expect(() => parseFaultPlan({ webhook: { lose: 0.1 } })).toThrow('unknown webhook fault lose')
    expect(() => parseFaultPlan({ slowMs: [3000, 500] })).toThrow('slowMs')
    expect(() => parseFaultPlan(null)).toThrow('object')
  })
})
