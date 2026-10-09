import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  AccountRegistry,
  PgCtePoster,
  pgAccountLoader,
  readBalance,
  RetriesExhaustedError,
  takeSnapshots,
  type Account,
  type BalanceMode,
} from '@carwash/ledger'
import { createTestDatabase, prepareTemplate } from '@carwash/testkit'
import type pg from 'pg'
import { appendJsonLine, createResultsDir, describeEnvironment, median, percentile, writeJson } from './env.ts'
import { mulberry32, runOpenLoop, type LoadResult } from './loadgen.ts'
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
  mode: string
  connections: number
  rate: number
  load: LoadResult
  attemptsPerJournal: number
  deadlocks: number
  rollbacks: number
  readMs: { p50: number; p99: number; count: number }
  snapshotMs: { p50: number; max: number; count: number }
  saturated: boolean
}

const { values } = parseArgs({
  options: {
    modes: { type: 'string', default: 'locked,serializable,derived,sharded-4,sharded-16,sharded-64' },
    connections: { type: 'string', default: '8,32,128' },
    rates: { type: 'string', default: '50,100,200,400,800,1200,1600,2400,3200' },
    duration: { type: 'string', default: '15' },
    warmup: { type: 'string', default: '3' },
    repeats: { type: 'string', default: '3' },
    merchants: { type: 'string', default: '1000' },
    zipf: { type: 'string', default: '0' },
    'snapshot-ms': { type: 'string', default: '1000' },
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
      if (cdf[mid]! < target) lo = mid + 1
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
  return { deadlocks: Number(result.rows[0]!.deadlocks), rollbacks: Number(result.rows[0]!.xact_rollback) }
}

async function runCell(spec: ModeSpec, connections: number, rate: number, repeat: number): Promise<Cell> {
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
    const [receivable, fees] = hot as [Account, Account]

    let attempts = 0
    let posted = 0
    let running = true
    const reads: number[] = []
    const snapshots: number[] = []

    const reader = (async () => {
      while (running) {
        for (const account of hot) {
          const started = performance.now()
          await readBalance(side, account)
          reads.push(performance.now() - started)
        }
        await sleep(50)
      }
    })()
    const snapshotter = (async () => {
      if (!spec.snapshots) return
      while (running) {
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
        const merchant = merchants[pick()]!
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
    running = false
    await Promise.all([reader, snapshotter])
    const after = await databaseStats(admin, db.name)

    reads.sort((a, b) => a - b)
    snapshots.sort((a, b) => a - b)
    const saturated =
      load.achievedPerSecond < rate * 0.95 || load.dropped > 0 || load.errors > 0 || load.latencyMs.p99 > 1000
    return {
      repeat,
      mode: spec.name,
      connections,
      rate,
      load,
      attemptsPerJournal: posted > 0 ? attempts / posted : 0,
      deadlocks: after.deadlocks - before.deadlocks,
      rollbacks: after.rollbacks - before.rollbacks,
      readMs: { p50: percentile(reads, 50), p99: percentile(reads, 99), count: reads.length },
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
            `read99 ${cell.readMs.p99.toFixed(1)}${cell.saturated ? ' SATURATED' : ''}`,
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
    })),
  )
}

await main()
