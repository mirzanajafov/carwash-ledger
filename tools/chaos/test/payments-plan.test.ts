import { mulberry32 } from '@carwash/lab'
import { describe, expect, it } from 'vitest'
import { planPayments, PRICES, PROXIES, SERVICES, split, type PaymentsPlanOptions } from '../src/payments/plan.ts'

const options: PaymentsPlanOptions = {
  seed: 3,
  durationMs: 60_000,
  rate: 30,
  clients: 4,
  merchants: 8,
  manualShare: 0.3,
  cancelShare: 0.2,
  partialShare: 0.3,
  refundShare: 0.3,
  duplicateShare: 0.05,
  reuseShare: 0.03,
  rivalShare: 0.1,
  payoutEveryMs: 500,
  killEveryMs: 3000,
  postgresEveryMs: 20_000,
  kafkaEveryMs: 15_000,
  toxicEveryMs: 4000,
  forgeEveryMs: 1000,
}

describe('split', () => {
  it('cuts a total into positive parts that add up to it', () => {
    const random = mulberry32(1)
    for (let i = 0; i < 500; i++) {
      const total = 1 + Math.floor(random() * 5000)
      const parts = split(random, total, 1 + Math.floor(random() * 3))
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
      expect(parts.every((p) => p >= 1)).toBe(true)
    }
    expect(split(random, 2, 3)).toEqual([2])
  })
})

describe('planPayments', () => {
  it('is a pure function of the seed', () => {
    expect(planPayments(options)).toEqual(planPayments(options))
    expect(planPayments({ ...options, seed: 4 }).journeys).not.toEqual(planPayments(options).journeys)
  })

  it('plans journeys a car wash would see, and never refunds more than it captures', () => {
    const { journeys } = planPayments(options)
    expect(journeys.length).toBeGreaterThan(1600)
    expect(journeys.length).toBeLessThan(2000)
    for (const j of journeys) {
      expect(PRICES).toContain(j.amount)
      expect(j.captureAmount).toBeLessThanOrEqual(j.amount)
      if (j.captureAmount < j.amount) expect(j.capture).toBe('manual')
      expect(j.refunds.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(j.captureAmount)
      expect(j.refunds.every((r) => r >= 1)).toBe(true)
      if (j.settle === 'cancel') expect(j.refunds).toEqual([])
      if (j.rival) expect([j.capture, j.settle]).toEqual(['manual', 'capture'])
      expect(j.pauses).toHaveLength(1 + j.refunds.length)
    }
    const full = journeys.filter((j) => j.refunds.length > 0 && j.refunds.reduce((a, b) => a + b, 0) === j.captureAmount)
    expect(full.length).toBeGreaterThan(50)
    expect(journeys.filter((j) => j.capture === 'manual').length / journeys.length).toBeCloseTo(0.3, 1)
  })

  it('aims faults only at the services and proxies that exist, in time order', () => {
    const { faults, payouts, forgeries } = planPayments(options)
    expect(faults.map((f) => f.at)).toEqual([...faults.map((f) => f.at)].sort((a, b) => a - b))
    for (const fault of faults) {
      if (fault.kind === 'kill') expect(SERVICES).toContain(fault.target)
      if (fault.kind === 'toxic') expect(PROXIES).toContain(fault.proxy)
    }
    expect(payouts.length).toBeGreaterThan(90)
    expect(payouts.every((p) => p.merchant >= 0 && p.merchant < options.merchants)).toBe(true)
    expect(forgeries.length).toBeGreaterThan(40)
    expect(planPayments({ ...options, forgeEveryMs: 0 }).forgeries).toEqual([])
  })

  it('crashes Kafka for 0.2-5 s at a time, and not at all when asked not to', () => {
    const crashes = planPayments(options).faults.filter((f) => f.kind === 'kafka')
    expect(crashes.length).toBeGreaterThan(2)
    expect(crashes.every((f) => f.downMs >= 200 && f.downMs <= 5000)).toBe(true)
    expect(planPayments({ ...options, kafkaEveryMs: 0 }).faults.some((f) => f.kind === 'kafka')).toBe(false)
    expect(PROXIES).toContain('worker-kafka')
  })
})
