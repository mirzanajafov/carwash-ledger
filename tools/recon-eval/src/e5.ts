import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createResultsDir, writeJson } from '@carwash/lab'
import type { Fallback } from '@carwash/recon'
import { evaluate, type Evaluation } from './evaluate.ts'
import { FAULTS, generate, type Fault } from './generate.ts'

const { values } = parseArgs({
  options: {
    volumes: { type: 'string', default: '50,500,2000' },
    policies: { type: 'string', default: 'unique,oldest' },
    seeds: { type: 'string', default: '1,2,3' },
    days: { type: 'string', default: '30' },
    rate: { type: 'string', default: '0.01' },
    window: { type: 'string', default: '7' },
    skew: { type: 'string', default: '300' },
    out: { type: 'string', default: 'results' },
  },
})

const contract = { bps: 120n, fixed: 8n }
const rate = Number(values.rate)
const rates = Object.fromEntries(FAULTS.map((f) => [f, rate])) as Record<Fault, number>

interface Cell {
  perDay: number
  fallback: Fallback
  seed: number
  ms: number
  evaluation: Evaluation
}

const cells: Cell[] = []
for (const perDay of values.volumes.split(',').map(Number)) {
  for (const seed of values.seeds.split(',').map(Number)) {
    const world = generate({ seed, days: Number(values.days), perDay, partialShare: 0.1, refundShare: 0.05, rates, contract, skewMs: Number(values.skew) })
    for (const fallback of values.policies.split(',') as Fallback[]) {
      const started = performance.now()
      const evaluation = evaluate(world, { fallback, windowDays: Number(values.window), contract })
      cells.push({ perDay, fallback, seed, ms: Math.round(performance.now() - started), evaluation })
    }
  }
}

const groups = new Map<string, [Cell, ...Cell[]]>()
for (const cell of cells) groups.set(`${cell.perDay}/${cell.fallback}`, [...(groups.get(`${cell.perDay}/${cell.fallback}`) ?? []), cell])
const summary = [...groups.values()].map((group) => {
  const total = <T extends string>(pick: (e: Evaluation) => Record<T, number>, field: T) => group.reduce((n, c) => n + pick(c.evaluation)[field], 0)
  const perFault = Object.fromEntries(
    FAULTS.map((f) => {
      const injected = group.reduce((n, c) => n + c.evaluation.faults[f].injected, 0)
      const detected = group.reduce((n, c) => n + c.evaluation.faults[f].detected, 0)
      const wrongClass = group.reduce((n, c) => n + c.evaluation.faults[f].wrongClass, 0)
      return [f, { injected, detected, wrongClass, missed: injected - detected - wrongClass, detectionRate: injected === 0 ? null : detected / injected }]
    }),
  )
  const dropped = {
    placedRight: total((e) => e.dropped, 'placedRight'),
    placedWrong: total((e) => e.dropped, 'placedWrong'),
    unplaced: total((e) => e.dropped, 'unplaced'),
  }
  return {
    perDay: group[0].perDay,
    fallback: group[0].fallback,
    seeds: group.length,
    items: group.reduce((n, c) => n + c.evaluation.items, 0),
    lines: group.reduce((n, c) => n + c.evaluation.lines, 0),
    breaks: group.reduce((n, c) => n + c.evaluation.breaks, 0),
    falseBreaks: group.reduce((n, c) => n + c.evaluation.falseBreaks, 0),
    transientBreaks: group.reduce((n, c) => n + c.evaluation.transientBreaks, 0),
    transientByClass: group.reduce<Record<string, number>>((into, c) => {
      for (const [k, v] of Object.entries(c.evaluation.transientByClass)) into[k] = (into[k] ?? 0) + v
      return into
    }, {}),
    faults: perFault,
    dropped: { ...dropped, wrongShare: dropped.placedWrong / Math.max(1, dropped.placedRight + dropped.placedWrong + dropped.unplaced) },
    msPerRun: Math.round(group.reduce((n, c) => n + c.ms, 0) / group.length),
  }
})

const dir = createResultsDir(join(fileURLToPath(new URL('..', import.meta.url)), values.out))
writeJson(join(dir, 'run.json'), { experiment: 'e5', options: values, contract: { bps: 120, fixed: 8 }, node: process.version })
writeJson(join(dir, 'cells.json'), cells)
writeJson(join(dir, 'summary.json'), summary)
console.log(`writing to ${dir}`)
for (const row of summary) {
  const rates = Object.entries(row.faults)
    .map(([f, score]) => `${f} ${score.detected}/${score.injected}`)
    .join(', ')
  console.log(
    `${row.perDay}/day ${row.fallback}: ${rates}; dropped ${row.dropped.placedRight} right, ${row.dropped.placedWrong} wrong, ${row.dropped.unplaced} unplaced; ` +
      `false ${row.falseBreaks}, transient ${row.transientBreaks} ${JSON.stringify(row.transientByClass)}, ${row.msPerRun} ms`,
  )
}
