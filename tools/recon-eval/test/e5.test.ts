import { describe, expect, it } from 'vitest'
import { evaluate } from '../src/evaluate.ts'
import { FAULTS, generate, type Fault } from '../src/generate.ts'

const contract = { bps: 120n, fixed: 8n }
const none = Object.fromEntries(FAULTS.map((f) => [f, 0])) as Record<Fault, number>

function world(rates: Record<Fault, number>, seed = 7) {
  return generate({ seed, days: 6, perDay: 40, partialShare: 0.1, refundShare: 0.05, rates, contract, skewMs: 300 })
}

describe('the E5 generator and scorer', () => {
  it('generates the same world from the same seed', () => {
    const a = world({ ...none, missingLine: 0.1 })
    const b = world({ ...none, missingLine: 0.1 })
    expect(a.items.map((i) => [i.attemptId, String(i.gross), i.fault])).toEqual(b.items.map((i) => [i.attemptId, String(i.gross), i.fault]))
  })

  it('finds no breaks at all when the files are right', () => {
    const result = evaluate(world(none), { fallback: 'unique', windowDays: 7, contract })
    expect(result.breaks).toBe(0)
    expect(result.falseBreaks).toBe(0)
  })

  it('labels every injected fault and credits a break of the expected class', () => {
    for (const fault of ['missingLine', 'duplicateLine', 'wrongAmount', 'feeDifference'] as const) {
      const result = evaluate(world({ ...none, [fault]: 0.2 }), { fallback: 'unique', windowDays: 7, contract })
      expect(result.faults[fault].injected).toBeGreaterThan(10)
      expect(result.faults[fault].detected).toBe(result.faults[fault].injected)
      expect(result.falseBreaks).toBe(0)
    }
  })

  it('sees the line of an item at the edge of the window when the PSP put it in the day before', () => {
    const skewed = generate({ seed: 3, days: 10, perDay: 40, partialShare: 0, refundShare: 0, rates: none, contract, skewMs: 4 * 3_600_000 })
    const result = evaluate(skewed, { fallback: 'unique', windowDays: 2, contract })
    expect(result.falseBreaks).toBe(0)
  })
})
