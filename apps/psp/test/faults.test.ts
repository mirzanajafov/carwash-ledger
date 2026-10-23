import { describe, expect, it } from 'vitest'
import { FaultPlanInput, Faults, NO_FAULTS, parseToken, WeatherRequest, type TokenEffect } from '../src/faults.ts'

describe('parseToken', () => {
  it('reads every kind of test token and rejects anything else', () => {
    expect(parseToken('tok_ok')).toEqual({ kind: 'ok' })
    expect(parseToken('tok_decline')).toEqual({ kind: 'decline' })
    expect(parseToken('tok_fail_once_capture')).toEqual({ kind: 'fail_once', operation: 'capture' })
    expect(parseToken('tok_timeout_after_refund')).toEqual({ kind: 'timeout_after', operation: 'refund' })
    expect(parseToken('tok_drop_after_authorize')).toEqual({ kind: 'drop_after', operation: 'authorize' })
    expect(parseToken('tok_webhook_reorder')).toEqual({ kind: 'webhook', fault: 'reorder' })
    expect(parseToken('tok_wrong_amount_refund')).toEqual({ kind: 'wrong_amount', operation: 'refund' })
    expect(parseToken('tok_fail_payout')).toBeUndefined()
    expect(parseToken('4242424242424242')).toBeUndefined()
  })
})

describe('Faults', () => {
  it('fails a fail_once operation only the first time its key is seen', () => {
    const faults = new Faults()
    const token: TokenEffect = { kind: 'fail_once', operation: 'capture' }
    expect(faults.behaviour('k1', 'capture', token).fail).toBe(true)
    expect(faults.behaviour('k1', 'capture', token).fail).toBe(false)
    expect(faults.behaviour('k2', 'capture', token).fail).toBe(true)
    expect(faults.behaviour('k3', 'refund', token).fail).toBe(false)
  })

  it('applies a token only to the operation it names', () => {
    const faults = new Faults()
    const token: TokenEffect = { kind: 'timeout_after', operation: 'capture' }
    expect(faults.behaviour('a', 'capture', token).afterCommit).toBe('hang')
    expect(faults.behaviour('b', 'authorize', token).afterCommit).toBe('answer')
    expect(faults.behaviour('c', 'authorize', { kind: 'decline' }).decline).toBe(true)
    expect(faults.behaviour('d', 'capture', { kind: 'decline' }).decline).toBe(false)
    expect(faults.behaviour('e', 'capture', { kind: 'wrong_amount', operation: 'capture' }).wrongAmount).toBe(true)
    expect(faults.behaviour('f', 'refund', { kind: 'wrong_amount', operation: 'capture' }).wrongAmount).toBe(false)
  })

  it('declines authorizations and payouts from the plan, never captures or refunds', () => {
    const faults = new Faults(FaultPlanInput.parse({ decline: 1, wrongAmount: 1 }))
    const ok: TokenEffect = { kind: 'ok' }
    expect(faults.behaviour('a', 'authorize', ok)).toMatchObject({ decline: true, wrongAmount: false })
    expect(faults.behaviour('b', 'payout', ok)).toMatchObject({ decline: true, wrongAmount: true })
    expect(faults.behaviour('c', 'capture', ok)).toMatchObject({ decline: false, wrongAmount: true })
    expect(faults.behaviour('d', 'refund', ok)).toMatchObject({ decline: false, wrongAmount: true })
  })

  it('draws the same faults for the same seed and key whatever else was asked in between', () => {
    const plan = FaultPlanInput.parse({ seed: 7, fail: 0.3, slow: 0.3, timeoutAfterCommit: 0.3, webhook: { duplicate: 0.3, drop: 0.3 } })
    const ok: TokenEffect = { kind: 'ok' }
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
      expect([b.decline, b.fail, b.afterCommit, b.slowMs, b.wrongAmount, b.webhook.size]).toEqual([false, false, 'answer', 0, false, 0])
    }
  })
})

describe('the fault plan', () => {
  it('fills in zeros and rejects anything it does not understand', () => {
    expect(FaultPlanInput.parse({ decline: 0.5 })).toEqual({ ...NO_FAULTS, decline: 0.5 })
    expect(() => FaultPlanInput.parse({ decline: 1.5 })).toThrow('decline must be a probability')
    expect(() => FaultPlanInput.parse({ timeout: 0.1 })).toThrow('unknown fault plan field timeout')
    expect(() => FaultPlanInput.parse({ webhook: { lose: 0.1 } })).toThrow('unknown webhook fault lose')
    expect(() => FaultPlanInput.parse({ slowMs: [3000, 500] })).toThrow('slowMs')
    expect(() => FaultPlanInput.parse(null)).toThrow('object')
  })
})

describe('the weather', () => {
  it('lays a temporary plan over the base one and goes back on its own', () => {
    let now = 1_000_000
    const base = FaultPlanInput.parse({ fail: 0.01 })
    const faults = new Faults(base, () => now)
    const storm = FaultPlanInput.parse({ decline: 1 })
    faults.setWeather('storm', storm, 60)
    expect(faults.plan).toBe(storm)
    expect(faults.behaviour('a', 'authorize', { kind: 'ok' }).decline).toBe(true)
    now += 59_999
    expect(faults.weather?.label).toBe('storm')
    now += 1
    expect(faults.weather).toBeUndefined()
    expect(faults.plan).toBe(base)
    expect(faults.behaviour('b', 'authorize', { kind: 'ok' }).decline).toBe(false)
  })

  it('is cleared by a new base plan and by an explicit clear', () => {
    const faults = new Faults(NO_FAULTS, () => 0)
    faults.setWeather('flaky', FaultPlanInput.parse({ fail: 0.5 }), 300)
    const next = FaultPlanInput.parse({ slow: 0.1 })
    faults.plan = next
    expect(faults.weather).toBeUndefined()
    expect(faults.plan).toBe(next)
    faults.setWeather('flaky', FaultPlanInput.parse({ fail: 0.5 }), 300)
    faults.clearWeather()
    expect(faults.plan).toBe(next)
  })

  it('takes a label, a plan and a bounded number of seconds, and nothing else', () => {
    expect(WeatherRequest.parse({ label: 'storm', plan: { fail: 0.2 }, seconds: 300 })).toEqual({
      label: 'storm',
      plan: { ...NO_FAULTS, fail: 0.2 },
      seconds: 300,
    })
    expect(() => WeatherRequest.parse({ label: 'storm', plan: {}, seconds: 0 })).toThrow('seconds')
    expect(() => WeatherRequest.parse({ label: 'storm', plan: {}, seconds: 3601 })).toThrow('seconds')
    expect(() => WeatherRequest.parse({ label: 'storm', plan: {}, seconds: 1.5 })).toThrow('seconds')
    expect(() => WeatherRequest.parse({ label: '<b>', plan: {}, seconds: 60 })).toThrow('label')
    expect(() => WeatherRequest.parse({ label: 'storm', plan: { fail: 2 }, seconds: 60 })).toThrow('fail must be a probability')
    expect(() => WeatherRequest.parse({ label: 'storm', plan: {}, seconds: 60, forever: true })).toThrow('unknown weather field forever')
  })
})
