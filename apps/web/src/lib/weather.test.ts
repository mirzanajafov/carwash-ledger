import { describe, expect, it } from 'vitest'
import { describePlan, presetNamed, PRESETS, secondsLeft, Turn } from './weather'

describe('the bank weather', () => {
  it('keeps every preset a valid plan of probabilities', () => {
    for (const preset of PRESETS) {
      if (!preset.plan) continue
      const values = [preset.plan.decline, preset.plan.fail, preset.plan.timeoutAfterCommit, preset.plan.slow, preset.plan.wrongAmount]
      for (const value of [...values, ...Object.values(preset.plan.webhook ?? {}), ...Object.values(preset.plan.settlement ?? {})]) {
        expect(value === undefined || (value >= 0 && value <= 1)).toBe(true)
      }
    }
    expect(presetNamed('calm')?.plan).toBeNull()
    expect(presetNamed('hurricane')).toBeUndefined()
  })

  it('gives one change a minute to everyone and says how long to wait', () => {
    const turn = new Turn(60_000)
    expect(turn.take(1_000_000)).toBe(0)
    expect(turn.take(1_000_001)).toBe(60)
    expect(turn.take(1_059_000)).toBe(1)
    expect(turn.take(1_060_000)).toBe(0)
  })

  it('names only the faults a plan turns on', () => {
    expect(
      describePlan({ fail: 0.15, timeoutAfterCommit: 0.005, webhook: { duplicate: 0.4, drop: 0 }, settlement: { nextDay: 0.1, missingLine: 0.03 } }),
    ).toEqual(['15% fail', '0.5% time out after the work', '40% webhooks twice', '13% settlement lines off'])
    expect(describePlan({})).toEqual([])
  })

  it('counts the seconds left and never below zero', () => {
    expect(secondsLeft('2026-10-14T12:05:00.000Z', Date.parse('2026-10-14T12:00:00.500Z'))).toBe(300)
    expect(secondsLeft('2026-10-14T12:05:00.000Z', Date.parse('2026-10-14T12:06:00.000Z'))).toBe(0)
  })
})
