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

function e4() {
  const dirs = existsSync(join(BENCH, 'e4')) ? readdirSync(join(BENCH, 'e4')).sort() : []
  const mode = (dir: string) => json(join(BENCH, 'e4', dir, 'run.json')).mode as string
  const steadyDir = dirs.filter((d) => existsSync(join(BENCH, 'e4', d, 'summary.json')) && mode(d) === 'steady').at(-1)
  const range = (r: { median: number; min: number; max: number } | null, digits = 1) =>
    r ? { median: round(r.median, digits), min: round(r.min, digits), max: round(r.max, digits) } : null
  const steady = steadyDir
    ? (json(join(BENCH, 'e4', steadyDir, 'summary.json')) as any[]).map((r) => ({
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
      const o = json(join(BENCH, 'e4', d, 'outage.json'))
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
  const latest = (file: string) => dirs.filter((d) => existsSync(join(root, d, file))).at(-1)
  const scaleDir = latest('scale.json')
  const lagDir = latest('lag.json')
  const trialsDir = latest('trials.json')
  const scale = scaleDir
    ? (json(join(root, scaleDir, 'scale.json')) as any[])
        .filter((step) => step.size)
        .map((step) => ({
          size: step.size,
          sequencerPerSecond: step.sequencer.perSecond,
          verifyS: round(step.verifyMedianMs / 1000, 2),
          proofBytes: step.proofs.bytes,
          proofP50Ms: round(step.proofs.ms.p50, 2),
          auditBytesPerJournal: Math.round((step.bytes.audit_log + step.bytes.audit_nodes) / step.size),
        }))
    : []
  const incremental = scaleDir
    ? (json(join(root, scaleDir, 'scale.json')) as any[]).filter((step) => step.incremental).map((step) => ({ journals: step.incremental, ms: step.verifyMedianMs }))
    : []
  const lag = lagDir ? json(join(root, lagDir, 'lag.json')).lagMs : null
  const trials = trialsDir ? json(join(root, trialsDir, 'trials.json')) : null
  return {
    source: [scaleDir, lagDir, trialsDir].filter(Boolean),
    scale,
    incremental,
    lag: lag ? { rate: 200, p50: Math.round(lag.p50), p99: Math.round(lag.p99), max: Math.round(lag.max) } : null,
    trials: trials
      ? Object.entries(trials.result as Record<string, any>).map(([key, row]) => ({
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
  const dirs = existsSync(root) ? readdirSync(root).sort().filter((d) => existsSync(join(root, d, 'summary.json'))) : []
  const runs = dirs.map((dir) => ({ dir, seed: json(join(root, dir, 'seed.json')), summary: json(join(root, dir, 'summary.json')) as any[] }))
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
  return new Set(files.filter(Boolean).map((file) => file.slice(dir.length + 1).split('/')[0]!))
}

function chaos() {
  const runs = []
  const committed = tracked('tools/chaos/results')
  for (const dir of readdirSync(CHAOS).sort()) {
    if (!committed.has(dir)) continue
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

const evidence = { e1: e1(), e2: e2(), e4: e4(), e5: e5(), e6: e6(), e7: e7(), chaos: chaos() }
writeFileSync(OUT, `${JSON.stringify(evidence, null, 1)}\n`)
console.log(`wrote ${OUT}: ${evidence.e1.points.length} E1 points, ${evidence.e2.rows.length} E2 rows, ${evidence.e4.steady.length} E4 rates and ${evidence.e4.outages.length} outages, ${evidence.e5.rows.length} E5 rows, ${evidence.e6.scale.length} E6 sizes and ${evidence.e6.trials.length} trial rows, ${evidence.e7.rows.length} E7 procedures, ${evidence.chaos.runs.length} chaos campaigns`)
