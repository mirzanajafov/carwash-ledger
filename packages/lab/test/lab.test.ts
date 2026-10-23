import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createResultsDir, distribution, median, mulberry32, percentile, pick, tenths, writeJson } from '../src/index.ts'

describe('the seeded random helpers', () => {
  it('draw the same numbers for a seed as every recorded run did', () => {
    const random = mulberry32(42)
    expect([random(), random(), random()]).toEqual([0.6011037519201636, 0.44829055899754167, 0.8524657934904099])
  })

  it('refuse to pick from an empty list', () => {
    expect(() => pick(mulberry32(1), [])).toThrow('cannot pick from an empty list')
  })
})

describe('the statistics', () => {
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

describe('the results files', () => {
  const roots: string[] = []

  function root(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lab-'))
    roots.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('go in a folder named by the time of the run, with the mutant after it when there is one', () => {
    expect(basename(createResultsDir(root()))).toMatch(/^\d{8}-\d{6}$/)
    expect(basename(createResultsDir(root(), 'M10'))).toMatch(/^\d{8}-\d{6}-M10$/)
  })

  it('write bigints as strings', () => {
    const file = writeJson(join(root(), 'run.json'), { total: 12n })
    expect(readFileSync(file, 'utf8')).toBe('{\n  "total": "12"\n}\n')
  })
})
