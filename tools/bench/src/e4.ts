import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ensureTopics, kafkaClient, topicSpecs, writeEvent } from '@carwash/outbox'
import { createTestDatabase, prepareTemplate, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { appendJsonLine, createResultsDir, describeEnvironment, median, percentile, writeJson } from './env.ts'
import { mulberry32, runOpenLoop, type LoadResult } from './loadgen.ts'

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'steady' },
    rates: { type: 'string', default: '100,500,2000' },
    duration: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '10' },
    repeats: { type: 'string', default: '5' },
    keys: { type: 'string', default: '1000' },
    brokers: { type: 'string', default: 'kafka:19092' },
    'outage-rate': { type: 'string', default: '500' },
    'outage-at': { type: 'string', default: '30' },
    'outage-total': { type: 'string', default: '150' },
    seed: { type: 'string', default: '1' },
    pause: { type: 'string', default: '10' },
    out: { type: 'string', default: 'results/e4' },
  },
})

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BROKERS = values.brokers!.split(',')
const KEYS = Number(values.keys)
const kafka = kafkaClient({ brokers: BROKERS, clientId: 'e4-bench' })

interface Lags {
  count: number
  p50: number
  p99: number
  max: number
}

interface Timed {
  createdMs: number
  publishedMs: number
  consumedMs: number
}

interface Child {
  process: ChildProcess
  ready: Promise<void>
}

function lags(values: readonly number[]): Lags {
  const sorted = Float64Array.from(values).sort()
  return { count: sorted.length, p50: percentile(sorted, 50), p99: percentile(sorted, 99), max: sorted.at(-1) ?? Number.NaN }
}

function payload(n: number): Record<string, unknown> {
  return {
    id: `0199d5a0-${String(n).padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0').slice(-12)}`,
    object: 'payment',
    merchant: `wash_${n % 50}`,
    amount: 1500,
    currency: 'EUR',
    capture_mode: 'auto',
    status: 'captured',
    captured_amount: 1500,
    refunded_amount: 0,
    fee: 40,
    failure_reason: null,
    created: 1791871992,
    n,
  }
}

function child(file: string, env: NodeJS.ProcessEnv): Child {
  const process_ = spawn(process.execPath, ['--conditions=source', join(HERE, file)], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  const ready = new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: process_.stdout! })
    lines.on('line', (line) => {
      if (line.endsWith(': ready')) resolve()
      else console.log(line)
    })
    process_.once('exit', (code) => reject(new Error(`${file} exited with ${code} before it was ready`)))
  })
  return { process: process_, ready }
}

async function stop(child_: Child): Promise<void> {
  if (child_.process.exitCode !== null) return
  const exited = new Promise((resolve) => child_.process.once('exit', resolve))
  child_.process.kill('SIGTERM')
  if ((await Promise.race([exited.then(() => true), sleep(20_000, false)])) === false) child_.process.kill('SIGKILL')
}

interface Lab {
  db: TestDatabase
  writer: pg.Pool
  admin: pg.Pool
  relay: Child
  consumer: Child
  prefix: string
}

async function openLab(name: string): Promise<Lab> {
  const db = await createTestDatabase()
  const owner = db.pool('ledger_owner', 1)
  await owner.query('CREATE TABLE e4_consumed (event_id uuid PRIMARY KEY, consumed_at timestamptz NOT NULL)')
  await owner.query('GRANT SELECT, INSERT ON e4_consumed TO ledger_app')
  const prefix = `e4-${Date.now()}-${name}.`
  await ensureTopics(kafka, topicSpecs(prefix))
  const env = { ...process.env, E4_DB_URL: db.url('ledger_app'), E4_BROKERS: BROKERS.join(','), E4_PREFIX: prefix, E4_PAUSE_MS: values.pause }
  const relay = child('e4-relay.ts', env)
  const consumer = child('e4-consumer.ts', env)
  await Promise.all([relay.ready, consumer.ready])
  return { db, writer: db.pool('ledger_app', 32), admin: db.pool('admin', 2), relay, consumer, prefix }
}

async function closeLab(lab: Lab): Promise<void> {
  await Promise.all([stop(lab.relay), stop(lab.consumer)])
  const admin = kafka.admin()
  await admin.connect()
  await admin.deleteTopics({ topics: topicSpecs(lab.prefix).map((spec) => spec.topic) }).catch(() => undefined)
  await admin.disconnect()
  await lab.db.drop()
}

async function dbNow(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ ms: number }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms')
  return rows[0]!.ms
}

async function counters(pool: pg.Pool, database: string): Promise<{ commits: number; walSyncs: number }> {
  const { rows } = await pool.query<{ commits: string; syncs: string }>(
    `SELECT (SELECT xact_commit FROM pg_stat_database WHERE datname = $1)::text AS commits,
            (SELECT coalesce(sum(fsyncs), 0) FROM pg_stat_io WHERE object = 'wal')::text AS syncs`,
    [database],
  )
  return { commits: Number(rows[0]!.commits), walSyncs: Number(rows[0]!.syncs) }
}

async function untilDrained(pool: pg.Pool, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM outbox o WHERE NOT EXISTS (SELECT 1 FROM e4_consumed c WHERE c.event_id = o.event_id)',
    )
    if (rows[0]!.n === 0) return true
    if (Date.now() > deadline) return false
    await sleep(250)
  }
}

async function timings(pool: pg.Pool, originMs: number): Promise<Timed[]> {
  const { rows } = await pool.query<{ created: number; published: number; consumed: number }>(
    `SELECT (extract(epoch FROM o.created_at) * 1000)::float8 - $1 AS created,
            (extract(epoch FROM o.published_at) * 1000)::float8 - $1 AS published,
            (extract(epoch FROM c.consumed_at) * 1000)::float8 - $1 AS consumed
     FROM outbox o JOIN e4_consumed c ON c.event_id = o.event_id
     ORDER BY o.id`,
    [originMs],
  )
  return rows.map((r) => ({ createdMs: r.created, publishedMs: r.published, consumedMs: r.consumed }))
}

function writes(lab: Lab, rate: number, warmupMs: number, durationMs: number, seed: number): Promise<LoadResult> {
  const random = mulberry32(seed)
  const keys = Array.from({ length: KEYS }, (_, i) => `key-${i}`)
  return runOpenLoop({
    rate,
    durationMs,
    warmupMs,
    seed,
    maxInFlight: 256,
    task: async (index) => {
      await writeEvent(lab.writer, {
        topic: 'payments',
        key: keys[Math.floor(random() * keys.length)]!,
        type: 'payment.captured',
        payload: payload(index),
      })
      return 'ok'
    },
  })
}

function writerValid(load: LoadResult): boolean {
  return load.dropped === 0 && load.errors === 0 && load.lagMs.p99 <= 50
}

async function steadyCell(rate: number, repeat: number, warmupMs: number, durationMs: number, seed: number) {
  const lab = await openLab(`r${rate}-${repeat}`)
  try {
    const startedAt = new Date().toISOString()
    const origin = await dbNow(lab.admin)
    const counting = (async () => {
      await sleep(warmupMs)
      const before = await counters(lab.admin, lab.db.name)
      await sleep(durationMs)
      const after = await counters(lab.admin, lab.db.name)
      return { commits: after.commits - before.commits, walSyncs: after.walSyncs - before.walSyncs }
    })()
    const load = await writes(lab, rate, warmupMs, durationMs, seed)
    const committed = await counting
    const drained = await untilDrained(lab.admin, 120_000)
    const timed = (await timings(lab.admin, origin)).filter((t) => t.createdMs >= warmupMs && t.createdMs < warmupMs + durationMs)
    return {
      startedAt,
      rate,
      repeat,
      valid: writerValid(load) && drained,
      drained,
      writer: { achievedPerSecond: load.achievedPerSecond, lagMs: load.lagMs, dropped: load.dropped, errors: load.errors, cpuPercent: load.generatorCpuPercent },
      ackMs: lags(timed.map((t) => t.publishedMs - t.createdMs)),
      consumedMs: lags(timed.map((t) => t.consumedMs - t.createdMs)),
      transactionsPerEvent: committed.commits / Math.max(1, timed.length),
      walSyncsPerEvent: committed.walSyncs / Math.max(1, timed.length),
    }
  } finally {
    await closeLab(lab)
  }
}

function kafkaAccepts(): Promise<boolean> {
  const [host, port] = BROKERS[0]!.split(':')
  return new Promise((resolve) => {
    const socket = connect({ host: host!, port: Number(port), timeout: 1000 })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function perSecond(timed: readonly Timed[], totalMs: number) {
  const seconds = Math.ceil(totalMs / 1000) + 1
  const series = Array.from({ length: seconds }, (_, second) => ({ second, created: 0, published: 0, consumed: 0, backlog: 0, ackP99: Number.NaN }))
  const byCreated: number[][] = series.map(() => [])
  for (const t of timed) {
    const c = Math.floor(t.createdMs / 1000)
    const p = Math.floor(t.publishedMs / 1000)
    const k = Math.floor(t.consumedMs / 1000)
    if (series[c]) {
      series[c].created++
      byCreated[c]!.push(t.publishedMs - t.createdMs)
    }
    if (series[p]) series[p].published++
    if (series[k]) series[k].consumed++
  }
  let created = 0
  let published = 0
  for (const row of series) {
    created += row.created
    published += row.published
    row.backlog = created - published
    const sorted = Float64Array.from(byCreated[row.second]!).sort()
    row.ackP99 = percentile(sorted, 99)
  }
  return series
}

async function outage(rate: number, outageAtMs: number, totalMs: number, seed: number) {
  const lab = await openLab(`outage-${rate}`)
  try {
    const startedAt = new Date().toISOString()
    const origin = await dbNow(lab.admin)
    let killedMs = Number.NaN
    let backMs = Number.NaN
    const watch = (async () => {
      await sleep(outageAtMs)
      killedMs = (await dbNow(lab.admin)) - origin
      console.log('E4 OUTAGE kill kafka now')
      await sleep(3000)
      while (!(await kafkaAccepts())) await sleep(250)
      backMs = (await dbNow(lab.admin)) - origin
      console.log(`e4: kafka accepts connections again ${Math.round(backMs - killedMs)} ms after the kill`)
    })()
    const load = await writes(lab, rate, 0, totalMs, seed)
    await watch
    const drained = await untilDrained(lab.admin, 300_000)
    const timed = await timings(lab.admin, origin)
    const series = perSecond(timed, Math.max(totalMs, ...timed.map((t) => t.consumedMs)))
    const before = timed.filter((t) => t.createdMs >= 10_000 && t.createdMs < killedMs)
    const steadyP99 = lags(before.map((t) => t.publishedMs - t.createdMs)).p99
    const firstPublish = Math.min(...timed.filter((t) => t.publishedMs > killedMs + 1000).map((t) => t.publishedMs))
    const peak = Math.max(...series.map((row) => row.backlog))
    const backlog = timed.filter((t) => t.createdMs < firstPublish && t.publishedMs >= firstPublish)
    const drainEndMs = Math.max(...backlog.map((t) => t.publishedMs))
    const consumedEndMs = Math.max(...backlog.map((t) => t.consumedMs))
    const window = (from: number) => timed.filter((t) => t.createdMs >= from && t.createdMs < from + 5000).map((t) => t.publishedMs - t.createdMs)
    const recoveredAt = series.find((row) => row.second * 1000 >= backMs && row.second * 1000 + 5000 <= totalMs && lags(window(row.second * 1000)).p99 <= 2 * steadyP99)
    return {
      startedAt,
      rate,
      valid: writerValid(load) && drained,
      drained,
      writer: { achievedPerSecond: load.achievedPerSecond, lagMs: load.lagMs, dropped: load.dropped, errors: load.errors },
      steadyAckP99Ms: steadyP99,
      killedAtMs: Math.round(killedMs),
      kafkaAcceptsAfterMs: Math.round(backMs - killedMs),
      firstPublishAfterKillMs: Math.round(firstPublish - killedMs),
      firstPublishAfterKafkaMs: Math.round(firstPublish - backMs),
      peakBacklog: peak,
      backlogAtFirstPublish: backlog.length,
      drainSeconds: (drainEndMs - firstPublish) / 1000,
      drainPerSecond: backlog.length / ((drainEndMs - firstPublish) / 1000),
      consumedDrainSeconds: (consumedEndMs - firstPublish) / 1000,
      maxPublishedInOneSecond: Math.max(...series.filter((row) => row.second * 1000 >= firstPublish).map((row) => row.published)),
      recoveredAfterKafkaMs: recoveredAt ? Math.round(recoveredAt.second * 1000 - backMs) : null,
      series,
    }
  } finally {
    await closeLab(lab)
  }
}

async function main(): Promise<void> {
  await prepareTemplate()
  const dir = createResultsDir(values.out!)
  const probe = await createTestDatabase()
  const environment = await describeEnvironment(probe.pool('admin', 1))
  await probe.drop()
  writeJson(join(dir, 'run.json'), { experiment: 'e4', mode: values.mode, options: values, environment })
  console.log(`writing to ${dir}`)
  const seed = Number(values.seed)
  if (values.mode === 'outage') {
    const result = await outage(Number(values['outage-rate']), Number(values['outage-at']) * 1000, Number(values['outage-total']) * 1000, seed)
    writeJson(join(dir, 'outage.json'), result)
    const { series, ...rest } = result
    console.log(JSON.stringify(rest, null, 2))
    return
  }
  const rates = values.rates!.split(',').map(Number)
  const cells: Awaited<ReturnType<typeof steadyCell>>[] = []
  for (let repeat = 1; repeat <= Number(values.repeats); repeat++) {
    const order = rates.map((_, i) => rates[(i + repeat - 1) % rates.length]!)
    for (const rate of order) {
      const cell = await steadyCell(rate, repeat, Number(values.warmup) * 1000, Number(values.duration) * 1000, seed + repeat * 1000 + rate)
      appendJsonLine(join(dir, 'cells.jsonl'), cell)
      cells.push(cell)
      console.log(
        `rate ${rate} repeat ${repeat}: ack p50 ${cell.ackMs.p50.toFixed(1)} p99 ${cell.ackMs.p99.toFixed(1)} ms, ` +
          `consumer p50 ${cell.consumedMs.p50.toFixed(1)} p99 ${cell.consumedMs.p99.toFixed(1)} ms, ${cell.transactionsPerEvent.toFixed(2)} transactions and ${cell.walSyncsPerEvent.toFixed(2)} WAL syncs per event${cell.valid ? '' : ' (invalid)'}`,
      )
    }
  }
  const summary = rates.map((rate) => {
    const valid = cells.filter((c) => c.rate === rate && c.valid)
    const pick = (f: (c: (typeof cells)[number]) => number) => {
      const xs = valid.map(f)
      return xs.length === 0 ? null : { median: median(xs), min: Math.min(...xs), max: Math.max(...xs) }
    }
    return {
      rate,
      validCells: valid.length,
      ackP50: pick((c) => c.ackMs.p50),
      ackP99: pick((c) => c.ackMs.p99),
      ackMax: pick((c) => c.ackMs.max),
      consumedP50: pick((c) => c.consumedMs.p50),
      consumedP99: pick((c) => c.consumedMs.p99),
      consumedMax: pick((c) => c.consumedMs.max),
      transactionsPerEvent: pick((c) => c.transactionsPerEvent),
      walSyncsPerEvent: pick((c) => c.walSyncsPerEvent),
    }
  })
  writeJson(join(dir, 'summary.json'), summary)
  console.log(JSON.stringify(summary, null, 2))
}

await main()
process.exit(0)
