import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const BENCH = join(ROOT, 'tools/bench/results')
const CHAOS = join(ROOT, 'tools/chaos/results')
const RECON = join(ROOT, 'tools/recon-eval/results')
const OUT = new URL('../src/data/evidence.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const E1_MAIN = '20261009-110802'
const E1_OVERRIDES: Record<string, string> = { 'locked-async': '20261009-132846' }
const E1_MODES = ['locked', 'locked-async', 'serializable', 'derived', 'sharded-16']

function json(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function lines(path: string): any[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function round(x: number, digits = 1): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}

function e1() {
  const cells = new Map<string, { mode: string; connections: number; rate: number; achieved: number[]; p99: number[] }>()
  const take = (dir: string, only?: string) => {
    for (const cell of lines(join(BENCH, 'e1', dir, 'cells.jsonl'))) {
      if (!E1_MODES.includes(cell.mode) || (only && cell.mode !== only)) continue
      if (!only && E1_OVERRIDES[cell.mode]) continue
      const key = `${cell.mode}:${cell.connections}:${cell.rate}`
      const row = cells.get(key) ?? { mode: cell.mode, connections: cell.connections, rate: cell.rate, achieved: [], p99: [] }
      row.achieved.push(cell.load.achievedPerSecond)
      row.p99.push(cell.load.latencyMs.p99)
      cells.set(key, row)
    }
  }
  take(E1_MAIN)
  for (const [mode, dir] of Object.entries(E1_OVERRIDES)) take(dir, mode)
  const points = [...cells.values()]
    .map((c) => ({ mode: c.mode, connections: c.connections, rate: c.rate, achieved: round(median(c.achieved)), p99: round(median(c.p99)) }))
    .sort((a, b) => a.mode.localeCompare(b.mode) || a.connections - b.connections || a.rate - b.rate)
  return { source: [E1_MAIN, ...Object.values(E1_OVERRIDES)], modes: E1_MODES, connections: [...new Set(points.map((p) => p.connections))].sort((a, b) => a - b), points }
}

function e2() {
  const dir = readdirSync(join(BENCH, 'e2')).sort().at(-1)!
  const result = json(join(BENCH, 'e2', dir, 'results.json'))
  const rows = (result.summary as any[]).map((s) => ({
    variant: s.variant,
    mode: s.mode,
    concurrency: s.concurrency,
    perSecond: round(s.journalsPerSecond.median),
    p50: round(s.p50Ms.median, 2),
    p99: round(s.p99Ms.median, 2),
    roundTrips: s.roundTripsPerJournal.median,
  }))
  return { source: dir, rows }
}

function e5() {
  const dir = readdirSync(RECON).sort().at(-1)!
  const rows = (json(join(RECON, dir, 'summary.json')) as any[]).map((r) => ({
    perDay: r.perDay,
    fallback: r.fallback,
    lines: r.lines,
    falseBreaks: r.falseBreaks,
    detection: Object.fromEntries(Object.entries(r.faults as Record<string, any>).map(([name, f]) => [name, round(f.detectionRate * 100)])),
    dropped: { right: r.dropped.placedRight, wrong: r.dropped.placedWrong, unplaced: r.dropped.unplaced },
  }))
  return { source: dir, rows }
}

function chaos() {
  const runs = []
  for (const dir of readdirSync(CHAOS).sort()) {
    const file = join(CHAOS, dir, 'summary.json')
    if (!existsSync(file)) continue
    const s = json(file)
    const sum = (counts: Record<string, number> | number | undefined): number => (typeof counts === 'number' ? counts : Object.values(counts ?? {}).reduce((a, b) => a + b, 0))
    runs.push({
      dir,
      mode: s.mode ?? 'ledger',
      mutant: s.mutant,
      runs: s.runs,
      journeys: s.journeys,
      kills: sum(s.randomKills) + sum(s.failpointKills),
      postgresKills: s.postgresKills ?? 0,
      kafkaKills: s.kafkaKills ?? 0,
      runsWithViolations: s.runsWithViolations,
      firstViolatingRun: s.firstViolatingRun,
      caughtBy: Object.keys(s.violationsByInvariant ?? {}),
    })
  }
  return { runs }
}

const evidence = { e1: e1(), e2: e2(), e5: e5(), chaos: chaos() }
writeFileSync(OUT, `${JSON.stringify(evidence, null, 1)}\n`)
console.log(`wrote ${OUT}: ${evidence.e1.points.length} E1 points, ${evidence.e2.rows.length} E2 rows, ${evidence.e5.rows.length} E5 rows, ${evidence.chaos.runs.length} chaos campaigns`)
