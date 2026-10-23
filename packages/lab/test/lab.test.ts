import { describe, expect, it } from 'vitest'
import { distribution, median, mulberry32, percentile, pick, tenths } from '../src/index.ts'

describe('the lab helpers', () => {
  it('draw the same numbers from the same seed, so a run can be repeated', () => {
    const first = mulberry32(42)
    const second = mulberry32(42)
    const draws = Array.from({ length: 5 }, () => first())
    expect(Array.from({ length: 5 }, () => second())).toEqual(draws)
    expect(draws.every((x) => x >= 0 && x < 1)).toBe(true)
    expect(() => pick(first, [])).toThrow('cannot pick from an empty list')
  })

  it('take the median and percentiles by rank', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 99)).toBe(10)
    expect(Number.isNaN(median([]))).toBe(true)
  })

  it('summarise a sample as its count, p50, p99 and maximum', () => {
    expect(distribution([3, 1, 2])).toEqual({ n: 3, p50: 2, p99: 3, max: 3 })
    expect(tenths(2.345)).toBe(2.3)
  })
})
