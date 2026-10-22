import { execFileSync } from 'node:child_process'
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

interface Stat {
  median: number
}

interface Range extends Stat {
  min: number
  max: number
}

interface E1Line {
  mode: string
  connections: number
  rate: number
  load: { achievedPerSecond: number; latencyMs: { p99: number } }
}

interface E2Results {
  summary: { variant: string; mode: string; concurrency: number; journalsPerSecond: Stat; p50Ms: Stat; p99Ms: Stat; roundTripsPerJournal: Stat }[]
}

interface E5Row {
  perDay: number
  fallback: string
  lines: number
  falseBreaks: number
  faults: Record<string, { detectionRate: number }>
  dropped: { placedRight: number; placedWrong: number; unplaced: number }
}

interface E4Rate {
  rate: number
  validCells: number
  ackP50: Range | null
  ackP99: Range | null
  consumedP50: Range | null
  consumedP99: Range | null
  transactionsPerEvent: Range | null
  walSyncsPerEvent: Range | null
}

interface E4Outage {
  valid: boolean
  kafkaAcceptsAfterMs: number
  firstPublishAfterKafkaMs: number
  peakBacklog: number
  drainPerSecond: number
  drainSeconds: number
  recoveredAfterKafkaMs: number | null
}

interface E6Size {
  size: number
  sequencer: { perSecond: number }
  verifyMedianMs: number
  proofs: { bytes: number; ms: { p50: number } }
  bytes: { audit_log: number; audit_nodes: number }
}

interface E6Increment {
  incremental: number
  verifyMedianMs: number
}

interface E6Trial {
  trials: number
  caught: number
  named: number
  caughtWithoutWitness: number
}

interface E7Procedure {
  procedure: string
  changeMs: number
  duringChange: { requests: number; errors: number; p99: number }
  baseline: { p99: number }
  longestLockWaitMs: number
  walBytes: number
}

type Counts = Record<string, number> | number | undefined

interface ChaosSummary {
  mode?: string
  mutant: string | null
  runs: number
  journeys: number
  randomKills: Counts
  failpointKills: Counts
  postgresKills?: number
  kafkaKills?: number
  runsWithViolations: number
  firstViolatingRun: number | null
  violationsByInvariant?: Record<string, number>
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function lines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line): unknown => JSON.parse(line))
}

function latest(dir: string): string {
  const name = readdirSync(dir).sort().at(-1)
  if (name === undefined) throw new Error(`${dir} has no results`)
  return name
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid]
  const lower = sorted.length % 2 ? upper : sorted[mid - 1]
  if (lower === undefined || upper === undefined) throw new Error('there is no median of nothing')
  return sorted.length % 2 ? upper : (lower + upper) / 2
}

function round(x: number, digits = 1): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}

interface E1Cell {
  mode: string
  connections: number
  rate: number
  achieved: number[]
  p99: number[]
}

function e1() {
  const cells = new Map<string, E1Cell>()
  const take = (dir: string, only?: string) => {
    for (const cell of lines(join(BENCH, 'e1', dir, 'cells.jsonl')) as E1Line[]) {
      if (!E1_MODES.includes(cell.mode) || (only && cell.mode !== only)) continue
      if (!only && E1_OVERRIDES[cell.mode]) continue
      const key = `${cell.mode}:${cell.connections}:${cell.rate}`
      const row: E1Cell = cells.get(key) ?? { mode: cell.mode, connections: cell.connections, rate: cell.rate, achieved: [], p99: [] }
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
  return {
    source: [E1_MAIN, ...Object.values(E1_OVERRIDES)],
    modes: E1_MODES,
    connections: [...new Set(points.map((p) => p.connections))].sort((a, b) => a - b),
    points,
  }
}

function e2() {
  const dir = latest(join(BENCH, 'e2'))
  const rows = (json(join(BENCH, 'e2', dir, 'results.json')) as E2Results).summary.map((s) => ({
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
  const dir = latest(RECON)
  const rows = (json(join(RECON, dir, 'summary.json')) as E5Row[]).map((r) => ({
    perDay: r.perDay,
    fallback: r.fallback,
    lines: r.lines,
    falseBreaks: r.falseBreaks,
    detection: Object.fromEntries(Object.entries(r.faults).map(([name, f]) => [name, round(f.detectionRate * 100)])),
    dropped: { right: r.dropped.placedRight, wrong: r.dropped.placedWrong, unplaced: r.dropped.unplaced },
  }))
  return { source: dir, rows }
}

function e4() {
  const dirs = existsSync(join(BENCH, 'e4')) ? readdirSync(join(BENCH, 'e4')).sort() : []
  const mode = (dir: string) => (json(join(BENCH, 'e4', dir, 'run.json')) as { mode: string }).mode
  const steadyDir = dirs.filter((d) => existsSync(join(BENCH, 'e4', d, 'summary.json')) && mode(d) === 'steady').at(-1)
  const range = (r: Range | null, digits = 1) => (r ? { median: round(r.median, digits), min: round(r.min, digits), max: round(r.max, digits) } : null)
  const steady = steadyDir
    ? (json(join(BENCH, 'e4', steadyDir, 'summary.json')) as E4Rate[]).map((r) => ({
        rate: r.rate,
        cells: r.validCells,
        ackP50: range(r.ackP50),
        ackP99: range(r.ackP99),
        consumedP50: range(r.consumedP50),
        consumedP99: range(r.consumedP99),
        transactionsPerEvent: range(r.transactionsPerEvent, 2),
        walSyncsPerEvent: range(r.walSyncsPerEvent, 2),
      }))
    : []
  const outages = dirs
    .filter((d) => existsSync(join(BENCH, 'e4', d, 'outage.json')))
    .slice(-3)
    .map((d) => {
      const o = json(join(BENCH, 'e4', d, 'outage.json')) as E4Outage
      return {
        dir: d,
        valid: o.valid,
        kafkaBackS: round(o.kafkaAcceptsAfterMs / 1000),
        firstPublishS: round(o.firstPublishAfterKafkaMs / 1000),
        peakBacklog: o.peakBacklog,
        drainPerSecond: Math.round(o.drainPerSecond),
        drainS: round(o.drainSeconds),
        settledS: o.recoveredAfterKafkaMs === null ? null : round(o.recoveredAfterKafkaMs / 1000),
      }
    })
  return { source: steadyDir ?? null, steady, outages }
}

function e6() {
  const root = join(BENCH, 'e6')
  const dirs = existsSync(root) ? readdirSync(root).sort() : []
  const latestWith = (file: string) => dirs.filter((d) => existsSync(join(root, d, file))).at(-1)
  const scaleDir = latestWith('scale.json')
  const lagDir = latestWith('lag.json')
  const trialsDir = latestWith('trials.json')
  const steps = scaleDir ? (json(join(root, scaleDir, 'scale.json')) as (E6Size | E6Increment)[]) : []
  const scale = steps
    .flatMap((step) => ('size' in step && step.size ? [step] : []))
    .map((step) => ({
      size: step.size,
      sequencerPerSecond: step.sequencer.perSecond,
      verifyS: round(step.verifyMedianMs / 1000, 2),
      proofBytes: step.proofs.bytes,
      proofP50Ms: round(step.proofs.ms.p50, 2),
      auditBytesPerJournal: Math.round((step.bytes.audit_log + step.bytes.audit_nodes) / step.size),
    }))
  const incremental = steps
    .flatMap((step) => ('incremental' in step && step.incremental ? [step] : []))
    .map((step) => ({ journals: step.incremental, ms: step.verifyMedianMs }))
  const lag = lagDir ? (json(join(root, lagDir, 'lag.json')) as { lagMs: { p50: number; p99: number; max: number } }).lagMs : null
  const trials = trialsDir ? (json(join(root, trialsDir, 'trials.json')) as { result: Record<string, E6Trial> }) : null
  return {
    source: [scaleDir, lagDir, trialsDir].filter(Boolean),
    scale,
    incremental,
    lag: lag ? { rate: 200, p50: Math.round(lag.p50), p99: Math.round(lag.p99), max: Math.round(lag.max) } : null,
    trials: trials
      ? Object.entries(trials.result)
          .map(([key, row]) => ({
            key,
            trials: row.trials,
            caught: row.caught,
            named: row.named,
            caughtWithoutWitness: row.caughtWithoutWitness,
          }))
          .sort((a, b) => a.key.slice(0, 7).localeCompare(b.key.slice(0, 7)) || Number(b.key.endsWith('covered')) - Number(a.key.endsWith('covered')))
      : [],
  }
}

function e7() {
  const root = join(BENCH, 'e7')
  const dirs = existsSync(root)
    ? readdirSync(root)
        .sort()
        .filter((d) => existsSync(join(root, d, 'summary.json')))
    : []
  const runs = dirs.map((dir) => ({
    dir,
    seed: json(join(root, dir, 'seed.json')) as { entries: number },
    summary: json(join(root, dir, 'summary.json')) as E7Procedure[],
  }))
  const biggest = runs.sort((a, b) => b.seed.entries - a.seed.entries)[0]
  if (!biggest) return { source: null, entries: 0, rows: [] }
  return {
    source: biggest.dir,
    entries: biggest.seed.entries,
    rows: biggest.summary.map((r) => ({
      procedure: r.procedure,
      changeS: round(r.changeMs / 1000),
      requests: r.duringChange.requests,
      errors: r.duringChange.errors,
      baselineP99: r.baseline.p99,
      p99: r.duringChange.p99,
      longestLockS: round(r.longestLockWaitMs / 1000),
      walGb: round(r.walBytes / 1e9),
    })),
  }
}

function tracked(dir: string): Set<string> {
  const files = execFileSync('git', ['ls-files', '--', dir], { cwd: ROOT, encoding: 'utf8' }).split('\n')
  return new Set(
    files.filter(Boolean).map((file) => {
      const [top = ''] = file.slice(dir.length + 1).split('/')
      return top
    }),
  )
}

function chaos() {
  const runs = []
  const committed = tracked('tools/chaos/results')
  for (const dir of readdirSync(CHAOS).sort()) {
    if (!committed.has(dir)) continue
    const file = join(CHAOS, dir, 'summary.json')
    if (!existsSync(file)) continue
    const s = json(file) as ChaosSummary
    const sum = (counts: Counts): number => (typeof counts === 'number' ? counts : Object.values(counts ?? {}).reduce((a, b) => a + b, 0))
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

const evidence = { e1: e1(), e2: e2(), e4: e4(), e5: e5(), e6: e6(), e7: e7(), chaos: chaos() }
writeFileSync(OUT, `${JSON.stringify(evidence, null, 1)}\n`)
console.log(
  `wrote ${OUT}: ${evidence.e1.points.length} E1 points, ${evidence.e2.rows.length} E2 rows, ${evidence.e4.steady.length} E4 rates and ${evidence.e4.outages.length} outages, ${evidence.e5.rows.length} E5 rows, ${evidence.e6.scale.length} E6 sizes and ${evidence.e6.trials.length} trial rows, ${evidence.e7.rows.length} E7 procedures, ${evidence.chaos.runs.length} chaos campaigns`,
)
