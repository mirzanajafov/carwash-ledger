import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import {
  Checkpointer,
  proveInclusion,
  sequenceBatch,
  tamper,
  treeSize,
  verifyLog,
  WitnessClient,
  type TamperClass,
  type VerifierState,
  type VerifyReport,
  type WitnessedRoots,
} from '@carwash/audit-pg'
import { checkLedger, violations } from '@carwash/invariants'
import { AccountRegistry, PgCtePoster, pgAccountLoader } from '@carwash/ledger'
import { createTestDatabase, prepareTemplate, type TestDatabase } from '@carwash/testkit'
import { createWitnessServer, Witness } from '@carwash/witness'
import type pg from 'pg'
import { appendJsonLine, createResultsDir, describeEnvironment, median, percentile, writeJson } from './env.ts'
import { mulberry32, runOpenLoop } from './loadgen.ts'

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'scale' },
    sizes: { type: 'string', default: '100000,500000,1000000' },
    increments: { type: 'string', default: '1000,10000,100000' },
    repeats: { type: 'string', default: '3' },
    'checkpoint-every': { type: 'string', default: '10000' },
    proofs: { type: 'string', default: '1000' },
    rate: { type: 'string', default: '200' },
    duration: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '10' },
    'trial-size': { type: 'string', default: '10250' },
    'trial-checkpoint-every': { type: 'string', default: '500' },
    trials: { type: 'string', default: '1000' },
    seed: { type: 'string', default: '1' },
    out: { type: 'string', default: 'results/e6' },
  },
})

const MERCHANTS = 50
const SEED_BATCH = 50_000

interface Lab {
  db: TestDatabase
  admin: pg.Pool
  app: pg.Pool
  audit: pg.Pool
  accounts: { receivable: string; fees: string; pspFees: string; merchants: string[] }
  witness: Witness
  checkpointer: Checkpointer
  close(): Promise<void>
}

interface Timing {
  ms: number
}

function stats(xs: readonly number[]) {
  const sorted = Float64Array.from(xs).sort()
  return { n: sorted.length, p50: percentile(sorted, 50), p99: percentile(sorted, 99), max: sorted.at(-1) ?? Number.NaN }
}

function round(x: number): number {
  return Math.round(x * 10) / 10
}

function timed(client: pg.PoolClient, clock: Timing): pg.ClientBase {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'query') {
        return async (...args: unknown[]) => {
          const started = performance.now()
          try {
            return await (target.query as (...a: unknown[]) => Promise<unknown>)(...args)
          } finally {
            clock.ms += performance.now() - started
          }
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function openLab(): Promise<Lab> {
  const db = await createTestDatabase()
  const admin = db.pool('admin', 2)
  const app = db.pool('ledger_app', 12)
  const audit = db.pool('ledger_audit', 2)
  const create = async (code: string, type: string) => {
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO accounts (code, type, currency, balance_mode, shards) VALUES ($1, $2::account_type, 'EUR', 'derived', 1) RETURNING id::text`,
      [code, type],
    )
    return rows[0]!.id
  }
  const accounts = {
    receivable: await create('psp_receivable', 'asset'),
    fees: await create('platform_fees', 'revenue'),
    pspFees: await create('psp_fees', 'expense'),
    merchants: [] as string[],
  }
  for (let i = 0; i < MERCHANTS; i++) accounts.merchants.push(await create(`merchant:wash_${i}`, 'liability'))
  const dir = mkdtempSync(join(tmpdir(), 'e6-witness-'))
  const witness = new Witness(dir, 'carwash-ledger')
  const server: Server = createWitnessServer(witness, 'e6')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const checkpointer = new Checkpointer(app, new WitnessClient(url, 'e6', 30_000))
  return {
    db,
    admin,
    app,
    audit,
    accounts,
    witness,
    checkpointer,
    async close() {
      server.close()
      rmSync(dir, { recursive: true, force: true })
      await db.drop()
    },
  }
}

function roots(lab: Lab): WitnessedRoots {
  return { origin: lab.witness.origin, publicKey: lab.witness.publicKey, checkpoints: lab.witness.history() }
}

async function seed(lab: Lab, from: number, to: number): Promise<number> {
  const started = performance.now()
  for (let start = from; start < to; start += SEED_BATCH) {
    const end = Math.min(start + SEED_BATCH, to) - 1
    const client = await lab.admin.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        `WITH j AS (
           INSERT INTO journals (external_ref) SELECT 'seed:' || g FROM generate_series($1::bigint, $2::bigint) g RETURNING id, external_ref
         ), n AS (
           SELECT id, substr(external_ref, 6)::bigint AS g, (ARRAY[900, 1500, 2400, 3500, 4900])[1 + substr(external_ref, 6)::bigint % 5]::bigint AS gross FROM j
         ), q AS (
           INSERT INTO audit_queue (journal_id) SELECT id FROM n
         )
         INSERT INTO entries (journal_id, account_id, amount)
         SELECT n.id, x.account_id, x.amount
         FROM n CROSS JOIN LATERAL (VALUES
           ($3::bigint, n.gross),
           (($6::bigint[])[1 + n.g % ${MERCHANTS}], -(n.gross - (n.gross * 2 / 100 + 10))),
           ($4::bigint, -(n.gross * 2 / 100 + 10) + CASE WHEN n.g % 3 = 0 THEN 8 ELSE 0 END),
           (CASE WHEN n.g % 3 = 0 THEN $5::bigint END, -8::bigint)
         ) AS x(account_id, amount)
         WHERE x.account_id IS NOT NULL`,
        [start, end, lab.accounts.receivable, lab.accounts.fees, lab.accounts.pspFees, lab.accounts.merchants],
      )
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  }
  await lab.admin.query('ANALYZE journals, entries, audit_queue')
  return performance.now() - started
}

async function sequenceAll(lab: Lab, checkpointEvery: number, closeWithCheckpoint = true) {
  const batch = Math.min(1000, checkpointEvery)
  const clock = { ms: 0 }
  const checkpoints: { size: number; ms: number; kind: string }[] = []
  let journals = 0
  let checkpointMs = 0
  let nextCheckpoint = Math.floor((await treeSize(lab.app)) / checkpointEvery + 1) * checkpointEvery
  const started = performance.now()
  for (;;) {
    const client = await lab.app.connect()
    let sequenced: number
    try {
      await client.query('BEGIN')
      sequenced = await sequenceBatch(timed(client, clock), batch)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    journals += sequenced
    const size = await treeSize(lab.app)
    const closing = closeWithCheckpoint && sequenced === 0 && size > 0 && lab.witness.latest()?.size !== size
    if (size >= nextCheckpoint || closing) {
      const at = performance.now()
      const outcome = await lab.checkpointer.run()
      const ms = performance.now() - at
      checkpointMs += ms
      checkpoints.push({ size, ms: round(ms), kind: outcome.kind })
      while (nextCheckpoint <= size) nextCheckpoint += checkpointEvery
    }
    if (sequenced === 0) break
  }
  const totalMs = performance.now() - started - checkpointMs
  return {
    journals,
    ms: Math.round(totalMs),
    perSecond: Math.round((journals / totalMs) * 1000),
    queryMs: Math.round(clock.ms),
    jsMs: Math.round(totalMs - clock.ms),
    checkpoints,
  }
}

async function verifyInSnapshot(lab: Lab, from?: VerifierState): Promise<VerifyReport> {
  const witness = roots(lab)
  const client = await lab.audit.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const report = await verifyLog(client, { witness, from })
    await client.query('COMMIT')
    if (report.findings > 0) throw new Error(`the verifier found ${report.findings} problems in an honest log: ${JSON.stringify(report.examples)}`)
    return report
  } finally {
    client.release()
  }
}

async function sizes(lab: Lab) {
  const { rows } = await lab.admin.query<{ name: string; bytes: string }>(
    `SELECT relname AS name, pg_total_relation_size(oid)::text AS bytes FROM pg_class
     WHERE relname IN ('journals', 'entries', 'audit_log', 'audit_nodes', 'audit_checkpoints')`,
  )
  return Object.fromEntries(rows.map((r) => [r.name, Number(r.bytes)]))
}

async function proofs(lab: Lab, size: number, count: number, random: () => number) {
  const ms: number[] = []
  const lengths: number[] = []
  for (let i = 0; i < count; i++) {
    const seq = Math.floor(random() * size)
    const started = performance.now()
    const proof = await proveInclusion(lab.app, seq, size)
    ms.push(performance.now() - started)
    lengths.push(proof.length)
  }
  return { size, ms: stats(ms), hashes: { min: Math.min(...lengths), max: Math.max(...lengths) }, bytes: { min: 32 * Math.min(...lengths), max: 32 * Math.max(...lengths) } }
}

async function scale(dir: string) {
  const targets = values.sizes!.split(',').map(Number)
  const increments = values.increments!.split(',').map(Number)
  const repeats = Number(values.repeats)
  const every = Number(values['checkpoint-every'])
  const random = mulberry32(Number(values.seed))
  const lab = await openLab()
  try {
    const result: Record<string, unknown>[] = []
    let size = 0
    let checked = false
    for (const target of targets) {
      const seedMs = await seed(lab, size, target)
      if (!checked) {
        const found = violations(await checkLedger(lab.audit))
        if (found.length > 0) throw new Error(`the seed breaks the ledger: ${JSON.stringify(found)}`)
        checked = true
      }
      const sequencer = await sequenceAll(lab, every)
      size = target
      const full: VerifyReport[] = []
      for (let r = 0; r < repeats; r++) full.push(await verifyInSnapshot(lab))
      const step = {
        size,
        seedMs: Math.round(seedMs),
        sequencer,
        verify: full.map((v) => ({ ...v.ms, journals: v.journals, witnessed: v.witnessed })),
        verifyMedianMs: median(full.map((v) => v.ms.total)),
        proofs: await proofs(lab, size, Number(values.proofs), random),
        bytes: await sizes(lab),
      }
      appendJsonLine(join(dir, 'scale.jsonl'), step)
      result.push(step)
      console.log(`size ${size}: sequencer ${sequencer.perSecond}/s, full verification median ${step.verifyMedianMs} ms`)
    }
    const base = (await verifyInSnapshot(lab)).state!
    let added = 0
    for (const increment of increments) {
      await seed(lab, size + added, size + increment)
      added = increment
      const sequencer = await sequenceAll(lab, every)
      const runs: VerifyReport[] = []
      for (let r = 0; r < repeats; r++) runs.push(await verifyInSnapshot(lab, base))
      const step = {
        incremental: increment,
        from: base.size,
        sequencer,
        verify: runs.map((v) => ({ ...v.ms, journals: v.journals, witnessed: v.witnessed })),
        verifyMedianMs: median(runs.map((v) => v.ms.total)),
      }
      appendJsonLine(join(dir, 'scale.jsonl'), step)
      result.push(step)
      console.log(`incremental ${increment} on ${base.size}: median ${step.verifyMedianMs} ms`)
    }
    writeJson(join(dir, 'scale.json'), result)
  } finally {
    await lab.close()
  }
}

async function lag(dir: string) {
  const lab = await openLab()
  const poster = new PgCtePoster(lab.app, new AccountRegistry(pgAccountLoader(lab.app)))
  const random = mulberry32(Number(values.seed))
  const stop = new AbortController()
  const checkpoints: { size: number; ms: number }[] = []
  const sequencer = (async () => {
    let lastCheckpoint = performance.now()
    while (!stop.signal.aborted) {
      for (;;) {
        const client = await lab.app.connect()
        try {
          await client.query('BEGIN')
          const n = await sequenceBatch(client, 1000)
          await client.query('COMMIT')
          if (n < 1000) break
        } finally {
          client.release()
        }
      }
      if (performance.now() - lastCheckpoint >= 10_000) {
        lastCheckpoint = performance.now()
        const outcome = await lab.checkpointer.run()
        if (outcome.kind === 'signed') checkpoints.push({ size: outcome.size, ms: round(performance.now() - lastCheckpoint) })
      }
      await sleep(1000, undefined, { signal: stop.signal }).catch(() => undefined)
    }
  })()
  try {
    const startedAt = (await lab.admin.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now
    const warmupMs = Number(values.warmup) * 1000
    const load = await runOpenLoop({
      rate: Number(values.rate),
      durationMs: Number(values.duration) * 1000,
      warmupMs,
      seed: Number(values.seed),
      maxInFlight: 64,
      task: async (index) => {
        const gross = [900, 1500, 2400, 3500, 4900][index % 5]!
        const fee = Math.floor((gross * 2) / 100) + 10
        await poster.post({
          externalRef: `lag:${index}`,
          entries: [
            { accountId: BigInt(lab.accounts.receivable), amount: BigInt(gross) },
            { accountId: BigInt(lab.accounts.merchants[Math.floor(random() * MERCHANTS)]!), amount: BigInt(-(gross - fee)) },
            { accountId: BigInt(lab.accounts.fees), amount: BigInt(-fee) },
          ],
        })
        return 'ok'
      },
    })
    while ((await lab.app.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_queue')).rows[0]!.n > 0) await sleep(200)
    stop.abort()
    await sequencer
    const { rows } = await lab.admin.query<{ ms: number }>(
      `SELECT extract(epoch FROM a.sequenced_at - j.created_at) * 1000 AS ms
       FROM audit_log a JOIN journals j ON j.id = a.journal_id
       WHERE j.created_at >= $1::timestamptz + make_interval(secs => $2::double precision / 1000)`,
      [startedAt, warmupMs],
    )
    const result = { load, lagMs: stats(rows.map((r) => Number(r.ms))), checkpoints }
    writeJson(join(dir, 'lag.json'), result)
    console.log(`lag at ${values.rate}/s: p50 ${round(result.lagMs.p50)} ms, p99 ${round(result.lagMs.p99)} ms, max ${round(result.lagMs.max)} ms`)
  } finally {
    stop.abort()
    await sequencer.catch(() => undefined)
    await lab.close()
  }
}

function named(tamperClass: TamperClass, seq: number, report: VerifyReport): boolean {
  return report.examples.some((f) => {
    if (tamperClass === 1) return f.kind === 'leaf' && f.seq === seq
    if (tamperClass === 3) return f.kind === 'missing_journal' && f.seq === seq
    return f.kind === 'root' && f.after <= seq && seq < f.size
  })
}

async function trials(dir: string) {
  const size = Number(values['trial-size'])
  const every = Number(values['trial-checkpoint-every'])
  const perClass = Number(values.trials)
  const random = mulberry32(Number(values.seed))
  const lab = await openLab()
  try {
    await seed(lab, 0, size)
    await sequenceAll(lab, every, false)
    const witnessed = roots(lab)
    const covered = witnessed.checkpoints.at(-1)!.size
    const summary: Record<string, { trials: number; caught: number; named: number; caughtWithoutWitness: number; ms: number[] }> = {}
    for (const tamperClass of [1, 2, 3] as const) {
      for (let i = 0; i < perClass; i++) {
        const inside = random() < 0.9 || covered === size
        const seq = inside ? Math.floor(random() * covered) : covered + Math.floor(random() * (size - covered))
        const client = await lab.admin.connect()
        try {
          await client.query('BEGIN')
          await tamper(client, tamperClass, seq)
          const started = performance.now()
          const withWitness = await verifyLog(client, { witness: witnessed })
          const ms = performance.now() - started
          const without = await verifyLog(client, {})
          await client.query('ROLLBACK')
          const trial = {
            tamperClass,
            seq,
            covered: inside,
            caught: withWitness.findings > 0,
            named: named(tamperClass, seq, withWitness),
            caughtWithoutWitness: without.findings > 0,
            ms: round(ms),
          }
          appendJsonLine(join(dir, 'trials.jsonl'), trial)
          const key = `class ${tamperClass}, ${inside ? 'covered' : 'above the last checkpoint'}`
          const row = (summary[key] ??= { trials: 0, caught: 0, named: 0, caughtWithoutWitness: 0, ms: [] })
          row.trials++
          row.caught += Number(trial.caught)
          row.named += Number(trial.named)
          row.caughtWithoutWitness += Number(trial.caughtWithoutWitness)
          row.ms.push(ms)
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          client.release()
        }
      }
      console.log(`class ${tamperClass} done`)
    }
    const result = Object.fromEntries(Object.entries(summary).map(([key, row]) => [key, { ...row, ms: stats(row.ms) }]))
    writeJson(join(dir, 'trials.json'), { size, checkpointEvery: every, covered, result })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await lab.close()
  }
}

await prepareTemplate()
const dir = createResultsDir(values.out!)
const probe = await createTestDatabase()
writeJson(join(dir, 'run.json'), { experiment: 'e6', mode: values.mode, options: values, environment: await describeEnvironment(probe.pool('admin', 1)) })
await probe.drop()
if (values.mode === 'scale') await scale(dir)
else if (values.mode === 'lag') await lag(dir)
else if (values.mode === 'trials') await trials(dir)
else throw new Error(`unknown mode ${values.mode}`)
console.log(`results in ${dir}`)
process.exit(0)
