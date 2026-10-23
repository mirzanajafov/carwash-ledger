import { describe, expect, it } from 'vitest'
import { PROGRAMS } from '@carwash/contracts'
import { mulberry32 } from '@carwash/lab'
import { gapMs, visit } from '../src/visits.ts'

describe('the car wash visits', () => {
  it('sells the five programs, captures most at once, and refunds a few for less than they paid', () => {
    const random = mulberry32(7)
    const visits = Array.from({ length: 10_000 }, () => visit(random, ['wash_north', 'wash_south']))
    const prices = new Set<number>(PROGRAMS.map((p) => p.price))
    expect(visits.every((v) => prices.has(v.amount))).toBe(true)
    expect(new Set(visits.map((v) => v.merchant))).toEqual(new Set(['wash_north', 'wash_south']))
    const share = (pick: (v: (typeof visits)[number]) => boolean) => visits.filter(pick).length / visits.length
    expect(share((v) => v.capture === 'manual')).toBeCloseTo(0.15, 1)
    expect(share((v) => v.token === 'tok_decline')).toBeCloseTo(0.04, 1)
    expect(share((v) => v.refund > 0)).toBeCloseTo(0.08, 1)
    expect(visits.every((v) => v.refund === 0 || (v.refund >= 100 && v.refund <= v.amount))).toBe(true)
  })

  it('spaces arrivals so that a minute holds about the asked number', () => {
    const random = mulberry32(3)
    const gaps = Array.from({ length: 20_000 }, () => gapMs(random, 12))
    expect(gaps.reduce((a, b) => a + b, 0) / gaps.length).toBeGreaterThan(4500)
    expect(gaps.reduce((a, b) => a + b, 0) / gaps.length).toBeLessThan(5500)
  })
})
