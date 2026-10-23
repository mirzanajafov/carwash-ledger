import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { appendJsonLine, createResultsDir, median, mulberry32, percentile, writeJson } from '@carwash/lab'
import { AccountRegistry, PgCtePoster, pgAccountLoader, readBalance, takeSnapshots, type BalanceMode } from '@carwash/ledger'
import { firstRow, RetriesExhaustedError } from '@carwash/pg'
import { createTestDatabase, prepareTemplate } from '@carwash/testkit'
import type pg from 'pg'
import { describeEnvironment } from './environment.ts'
import { runOpenLoop, type LoadResult } from './loadgen.ts'
import { seedCaptureAccounts } from './seed.ts'

interface ModeSpec {
  name: string
  mode: BalanceMode
  shards: number
  synchronousCommit: boolean
  merchantMode: BalanceMode
  snapshots: boolean
}

interface Cell {
  repeat: number
  startedAt: string
  mode: string
  connections: number
  rate: number
  load: LoadResult
  attemptsPerJournal: number
  deadlocks: number
  rollbacks: number
  readMs: { p50: number; p99: number; count: number; p99Every5s: number[] }
  longTransaction: boolean
  snapshotMs: { p50: number; max: number; count: number }
  saturated: boolean
}

const { values } = parseArgs({
  options: {
    modes: { type: 'string', default: 'locked,serializable,derived,sharded-4,sharded-16,sharded-64' },
    connections: { type: 'string', default: '8,32,128' },
    rates: { type: 'string', default: '50,100,150,200,300,400,800,1200,1600,2400,3200' },
    duration: { type: 'string', default: '15' },
    warmup: { type: 'string', default: '3' },
    repeats: { type: 'string', default: '3' },
    merchants: { type: 'string', default: '1000' },
    zipf: { type: 'string', default: '0' },
    'snapshot-ms': { type: 'string', default: '1000' },
    'long-tx': { type: 'boolean', default: false },
    'p99-limit': { type: 'string', default: '50' },
    seed: { type: 'string', default: '1' },
    out: { type: 'string', default: fileURLToPath(new URL('../results/e1', import.meta.url)) },
  },
})

function parseMode(name: string): ModeSpec {
  const base = { name, shards: 1, synchronousCommit: true, merchantMode: 'locked' as BalanceMode, snapshots: false }
  if (name === 'locked-async') return { ...base, mode: 'locked', synchronousCommit: false }
  if (name === 'entries-only') return { ...base, mode: 'derived', merchantMode: 'derived' }
  const sharded = /^sharded-(\d+)$/.exec(name)
  if (sharded) return { ...base, mode: 'sharded', shards: Number(sharded[1]) }
  if (name === 'derived') return { ...base, mode: 'derived', snapshots: snapshotEvery > 0 }
  if (name === 'locked' || name === 'serializable') return { ...base, mode: name }
  throw new Error(`unknown mode ${name}`)
}

const connectionCounts = values.connections.split(',').map(Number)
const rates = values.rates.split(',').map(Number)
const durationMs = Number(values.duration) * 1000
const warmupMs = Number(values.warmup) * 1000
const repeats = Number(values.repeats)
const merchantCount = Number(values.merchants)
const zipf = Number(values.zipf)
const snapshotEvery = Number(values['snapshot-ms'])
const longTransaction = values['long-tx']
const p99Limit = Number(values['p99-limit'])
const baseSeed = Number(values.seed)
const modes = values.modes.split(',').map(parseMode)

function merchantPicker(seed: number): () => number {
  const random = mulberry32(seed)
  if (zipf <= 0) return () => Math.floor(random() * merchantCount)
  const cdf = new Float64Array(merchantCount)
  let total = 0
  for (let i = 0; i < merchantCount; i++) cdf[i] = total += 1 / (i + 1) ** zipf
  return () => {
    const target = random() * total
    let lo = 0
    let hi = merchantCount - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const weight = cdf[mid]
      if (weight === undefined) throw new Error(`there is no cumulative weight at ${mid}`)
      if (weight < target) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

async function databaseStats(admin: pg.Pool, name: string): Promise<{ deadlocks: number; rollbacks: number }> {
  const result = await admin.query<{ deadlocks: string; xact_rollback: string }>(
    'SELECT deadlocks::text, xact_rollback::text FROM pg_stat_database WHERE datname = $1',
    [name],
  )
  const row = firstRow(result)
  return { deadlocks: Number(row.deadlocks), rollbacks: Number(row.xact_rollback) }
}

async function runCell(spec: ModeSpec, connections: number, rate: number, repeat: number): Promise<Cell> {
  const startedAt = new Date().toISOString()
  const db = await createTestDatabase()
  try {
    const admin = db.pool('admin', 1)
    if (!spec.synchronousCommit) await admin.query(`ALTER DATABASE "${db.name}" SET synchronous_commit = off`)
    const app = db.pool('ledger_app', connections)
    const side = db.pool('ledger_app', 2)
    const { hot, merchants } = await seedCaptureAccounts(side, spec.mode, spec.shards, merchantCount, spec.merchantMode)
    const registry = new AccountRegistry(pgAccountLoader(side))
    await registry.resolve([...hot.map((a) => a.id), ...merchants])
    const poster = new PgCtePoster(app, registry)
    const pick = merchantPicker(baseSeed * 7919 + repeat)
    const [receivable, fees] = hot

    let attempts = 0
    let posted = 0
    const stop = new AbortController()
    const reads: number[] = []
    const readLog: { at: number; ms: number }[] = []
    const snapshots: number[] = []
    const cellStart = performance.now()
    const holder = longTransaction ? await db.pool('ledger_app', 1).connect() : undefined
    if (holder) {
      await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await holder.query('SELECT pg_current_xact_id()')
    }

    const reader = (async () => {
      while (!stop.signal.aborted) {
        for (const account of hot) {
          const started = performance.now()
          await readBalance(side, account)
          const ms = performance.now() - started
          reads.push(ms)
          readLog.push({ at: started - cellStart, ms })
        }
        await sleep(50)
      }
    })()
    const snapshotter = (async () => {
      if (!spec.snapshots) return
      while (!stop.signal.aborted) {
        await sleep(snapshotEvery)
        const started = performance.now()
        await takeSnapshots(side)
        snapshots.push(performance.now() - started)
      }
    })()

    const before = await databaseStats(admin, db.name)
    const load = await runOpenLoop({
      rate,
      durationMs,
      warmupMs,
      seed: baseSeed * 104729 + repeat * 1009 + rate,
      maxInFlight: Math.max(1000, rate * 2),
      task: async (index) => {
        const picked = pick()
        const merchant = merchants[picked]
        if (merchant === undefined) throw new Error(`there is no merchant ${picked}`)
        const gross = 500n + BigInt(index % 3000)
        const fee = gross / 50n + 10n
        try {
          const result = await poster.post({
            externalRef: `capture:${index}`,
            entries: [
              { accountId: receivable.id, amount: gross },
              { accountId: merchant, amount: -(gross - fee) },
              { accountId: fees.id, amount: -fee },
            ],
          })
          attempts += result.attempts
          posted++
          return 'ok'
        } catch (error) {
          if (error instanceof RetriesExhaustedError) return 'gave-up'
          throw error
        }
      },
    })
    stop.abort()
    await Promise.all([reader, snapshotter])
    if (holder) {
      await holder.query('ROLLBACK')
      holder.release()
    }
    const after = await databaseStats(admin, db.name)

    reads.sort((a, b) => a - b)
    const p99Every5s: number[] = []
    for (let from = 0; readLog.some((r) => r.at >= from); from += 5000) {
      const bucket = readLog.filter((r) => r.at >= from && r.at < from + 5000).map((r) => r.ms)
      p99Every5s.push(
        percentile(
          bucket.sort((a, b) => a - b),
          99,
        ),
      )
    }
    snapshots.sort((a, b) => a - b)
    const saturated = load.achievedPerSecond * (durationMs / 1000) < load.measured * 0.95 || load.dropped > 0 || load.errors > 0 || load.latencyMs.p99 > 1000
    return {
      repeat,
      startedAt,
      mode: spec.name,
      connections,
      rate,
      load,
      attemptsPerJournal: posted > 0 ? attempts / posted : 0,
      deadlocks: after.deadlocks - before.deadlocks,
      rollbacks: after.rollbacks - before.rollbacks,
      readMs: { p50: percentile(reads, 50), p99: percentile(reads, 99), count: reads.length, p99Every5s },
      longTransaction,
      snapshotMs: { p50: percentile(snapshots, 50), max: snapshots.at(-1) ?? Number.NaN, count: snapshots.length },
      saturated,
    }
  } finally {
    await db.drop()
  }
}

function summarize(cells: readonly Cell[]) {
  const groups = new Map<string, Cell[]>()
  for (const cell of cells) {
    const key = `${cell.mode}|${cell.connections}`
    groups.set(key, [...(groups.get(key) ?? []), cell])
  }
  return [...groups.entries()].map(([key, group]) => {
    const [mode, connections] = key.split('|')
    const repeatsSeen = [...new Set(group.map((c) => c.repeat))]
    const highest = (accept: (c: Cell) => boolean) =>
      repeatsSeen.map((repeat) => {
        const ok = group.filter((c) => c.repeat === repeat && !c.saturated && c.load.gaveUp === 0 && accept(c))
        return ok.length > 0 ? Math.max(...ok.map((c) => c.rate)) : 0
      })
    return {
      mode,
      connections: Number(connections),
      sustained: highest((c) => c.load.latencyMs.p99 <= p99Limit),
      ceiling: highest(() => true),
      capacity: repeatsSeen.map((repeat) => Math.round(Math.max(...group.filter((c) => c.repeat === repeat).map((c) => c.load.achievedPerSecond)))),
    }
  })
}

async function main(): Promise<void> {
  await prepareTemplate()
  const probe = await createTestDatabase()
  const env = await describeEnvironment(probe.pool('admin', 1))
  await probe.drop()
  const options = {
    modes: modes.map((m) => m.name),
    connectionCounts,
    rates,
    durationMs,
    warmupMs,
    repeats,
    merchantCount,
    zipf,
    snapshotEvery,
    p99Limit,
  }
  const dir = createResultsDir(values.out)
  writeJson(join(dir, 'run.json'), { env, options })
  console.log(`writing to ${dir}`)

  const cells: Cell[] = []
  const pairs = modes.flatMap((spec) => connectionCounts.map((connections) => ({ spec, connections })))
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const offset = (repeat - 1) % pairs.length
    for (const { spec, connections } of [...pairs.slice(offset), ...pairs.slice(0, offset)]) {
      for (const rate of rates) {
        const cell = await runCell(spec, connections, rate, repeat)
        cells.push(cell)
        appendJsonLine(join(dir, 'cells.jsonl'), cell)
        const l = cell.load
        console.log(
          `${repeat} ${spec.name.padEnd(12)} c=${String(connections).padEnd(4)} offered ${String(rate).padStart(5)} ` +
            `got ${l.achievedPerSecond.toFixed(0).padStart(5)} p50 ${l.latencyMs.p50.toFixed(1).padStart(7)} ` +
            `p99 ${l.latencyMs.p99.toFixed(1).padStart(8)} ms attempts ${cell.attemptsPerJournal.toFixed(2)} ` +
            `gave-up ${l.gaveUp} dropped ${l.dropped} lag99 ${l.lagMs.p99.toFixed(1)} cpu ${l.generatorCpuPercent.toFixed(0)}% ` +
            `read99 ${cell.readMs.p99.toFixed(1)} last5s ${(cell.readMs.p99Every5s.at(-1) ?? Number.NaN).toFixed(1)}${cell.saturated ? ' SATURATED' : ''}`,
        )
        if (cell.saturated) break
      }
    }
  }

  const summary = summarize(cells)
  const file = writeJson(join(dir, 'results.json'), { env, options, summary, cells })
  console.log(`\nwrote ${file}`)
  console.table(
    summary.map((s) => ({
      mode: s.mode,
      connections: s.connections,
      [`p99 under ${p99Limit} ms`]: `${median(s.sustained)} (${s.sustained.join(' ')})`,
      'not saturated': `${median(s.ceiling)} (${s.ceiling.join(' ')})`,
      'max achieved': `${median(s.capacity)} (${s.capacity.join(' ')})`,
    })),
  )
}

await main()
