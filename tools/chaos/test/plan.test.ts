import { describe, expect, it } from 'vitest'
import { planRun, TOXIC_KINDS, type PlanOptions } from '../src/plan.ts'

const options: PlanOptions = {
  seed: 7,
  durationMs: 60_000,
  rate: 100,
  merchants: 20,
  posters: 4,
  reversalShare: 0.2,
  duplicateShare: 0.05,
  killEveryMs: 3000,
  postgresEveryMs: 20_000,
  toxicEveryMs: 4000,
}

describe('planRun', () => {
  it('is a pure function of the seed', () => {
    expect(planRun(options)).toEqual(planRun(options))
    expect(planRun({ ...options, seed: 8 }).journeys).not.toEqual(planRun(options).journeys)
  })

  it('draws journeys at about the asked rate, inside the run, with unique refs', () => {
    const { journeys } = planRun(options)
    expect(journeys.length).toBeGreaterThan(5400)
    expect(journeys.length).toBeLessThan(6600)
    expect(new Set(journeys.map((j) => j.ref)).size).toBe(journeys.length)
    expect(journeys.every((j) => j.at >= 0 && j.at < options.durationMs)).toBe(true)
    expect(journeys.every((j) => j.merchant >= 0 && j.merchant < options.merchants)).toBe(true)
    const reversed = journeys.filter((j) => j.reverse).length / journeys.length
    expect(reversed).toBeGreaterThan(0.17)
    expect(reversed).toBeLessThan(0.23)
  })

  it('orders faults in time and keeps every fault stream independent of the others', () => {
    const { faults } = planRun(options)
    expect(faults.map((f) => f.at)).toEqual([...faults.map((f) => f.at)].sort((a, b) => a - b))
    const kills = faults.filter((f) => f.kind === 'kill')
    expect(kills.every((f) => f.worker === 'snapshotter' || f.index < options.posters)).toBe(true)
    expect(faults.filter((f) => f.kind === 'toxic').every((f) => TOXIC_KINDS.includes(f.toxic))).toBe(true)

    const withoutPostgres = planRun({ ...options, postgresEveryMs: 0 }).faults
    expect(withoutPostgres.some((f) => f.kind === 'postgres')).toBe(false)
    expect(withoutPostgres).toEqual(faults.filter((f) => f.kind !== 'postgres'))
  })
})
