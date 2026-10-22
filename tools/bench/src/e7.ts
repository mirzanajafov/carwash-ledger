import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { checkLedger, violations } from '@carwash/invariants'
import { AccountRegistry, backfillEntryCurrency, PgCtePoster, pgAccountLoader, type BackfillResult } from '@carwash/ledger'
import { createPool, firstRow } from '@carwash/pg'
import { createTestDatabase, migrationNames, migrationSql, prepareTemplate, type TestDatabase } from '@carwash/testkit'
import pg from 'pg'
import { createResultsDir, describeEnvironment, percentile, writeJson } from './env.ts'
import { mulberry32 } from './loadgen.ts'
import { createSeedAccounts, grossOf, MERCHANTS, seedJournals, type SeedAccounts } from './ledger-seed.ts'

const { values } = parseArgs({
  options: {
    journals: { type: 'string', default: '6000000' },
    procedures: { type: 'string', default: 'naive,online' },
    rate: { type: 'string', default: '200' },
    before: { type: 'string', default: '30' },
    after: { type: 'string', default: '30' },
    batch: { type: 'string', default: '5000' },
    duty: { type: 'string', default: '0.5' },
    'max-in-flight': { type: 'string', default: '256' },
    'check-seed': { type: 'boolean', default: true },
    seed: { type: 'string', default: '1' },
    out: { type: 'string', default: 'results/e7' },
  },
})

const STEPS = migrationNames().filter((name) => name.includes('_entries_currency_'))
const BEFORE = migrationNames()[migrationNames().indexOf(migration('expand')) - 1]
if (BEFORE === undefined) throw new Error('there is no migration before entries_currency_expand')
const FUNCTIONS = ['ledger_check_balance', 'ledger_entry_currency', 'ledger_protect', 'ledger_stamp_entry']

interface Request {
  at: number
  ms: number
  end: number
  error: string | null
}

interface Sample {
  at: number
  longestMs: number
  waiting: number
}

interface Mark {
  at: number
  what: string
}

function stats(xs: readonly number[]) {
  const sorted = Float64Array.from(xs).sort()
  return { n: sorted.length, p50: percentile(sorted, 50), p99: percentile(sorted, 99), max: sorted.at(-1) ?? Number.NaN }
}

function round(x: number): number {
  return Math.round(x * 10) / 10
}

function migration(step: 'expand' | 'check' | 'validate' | 'finish'): string {
  const name = STEPS.find((candidate) => candidate.endsWith(`_entries_currency_${step}`))
  if (name === undefined) throw new Error(`there is no entries_currency_${step} migration`)
  return name
}

class Load {
  readonly requests: Request[] = []
  readonly started = performance.now()
  readonly #poster: PgCtePoster
  readonly #accounts: SeedAccounts
  readonly #rate: number
  readonly #maxInFlight: number
  readonly #random: () => number
  readonly #prefix: string
  readonly #recent: Request[] = []
  #inFlight = 0
  #n = 0
  #stop = false
  #loop: Promise<void> | undefined

  constructor(poster: PgCtePoster, accounts: SeedAccounts, rate: number, maxInFlight: number, seed: number, prefix: string) {
    this.#poster = poster
    this.#accounts = accounts
    this.#rate = rate
    this.#maxInFlight = maxInFlight
    this.#random = mulberry32(seed)
    this.#prefix = prefix
  }

  now(): number {
    return performance.now() - this.started
  }

  start(): void {
    this.#loop = (async () => {
      let next = 0
      while (!this.#stop) {
        const now = this.now()
        while (next <= now) {
          this.#fire(next)
          next += (-Math.log(1 - this.#random()) / this.#rate) * 1000
        }
        await sleep(Math.max(1, Math.min(10, next - now)))
      }
    })()
  }

  async stop(): Promise<void> {
    this.#stop = true
    await this.#loop
    while (this.#inFlight > 0) await sleep(20)
  }

  recentP99(windowMs: number): number {
    const from = this.now() - windowMs
    while (this.#recent[0] !== undefined && this.#recent[0].end < from) this.#recent.shift()
    return stats(this.#recent.map((r) => r.ms)).p99
  }

  #fire(at: number): void {
    if (this.#inFlight >= this.#maxInFlight) {
      this.requests.push({ at, ms: Number.NaN, end: at, error: 'dropped' })
      return
    }
    this.#inFlight++
    const n = this.#n++
    const gross = grossOf(n)
    const fee = Math.floor((gross * 2) / 100) + 10
    const merchant = this.#accounts.merchants[n % MERCHANTS]
    if (merchant === undefined) throw new Error(`there is no merchant ${n % MERCHANTS}`)
    void this.#poster
      .post({
        externalRef: `${this.#prefix}:${n}`,
        entries: [
          { accountId: BigInt(this.#accounts.receivable), amount: BigInt(gross) },
          { accountId: BigInt(merchant), amount: BigInt(-(gross - fee)) },
          { accountId: BigInt(this.#accounts.fees), amount: BigInt(-fee) },
        ],
      })
      .then(
        () => null,
        (error: unknown) => {
          if (!(error instanceof Error)) return 'unknown'
          return 'code' in error && typeof error.code === 'string' ? error.code : error.message
        },
      )
      .then((error) => {
        this.#inFlight--
        const end = this.now()
        const request = { at, ms: end - at, end, error }
        this.requests.push(request)
        if (error === null) this.#recent.push(request)
      })
  }
}

async function functionStats(admin: pg.Pool): Promise<Record<string, { calls: number; ms: number }>> {
  const { rows } = await admin.query<{ funcname: string; calls: string; total_time: number }>(
    'SELECT funcname, calls::text, total_time FROM pg_stat_user_functions WHERE funcname = ANY($1)',
    [FUNCTIONS],
  )
  return Object.fromEntries(rows.map((r) => [r.funcname, { calls: Number(r.calls), ms: r.total_time }]))
}

function perCall(from: Record<string, { calls: number; ms: number }>, to: Record<string, { calls: number; ms: number }>) {
  return Object.fromEntries(
    FUNCTIONS.map((name) => {
      const calls = (to[name]?.calls ?? 0) - (from[name]?.calls ?? 0)
      const ms = (to[name]?.ms ?? 0) - (from[name]?.ms ?? 0)
      return [name, { calls, usPerCall: calls > 0 ? round((ms * 1000) / calls) : null }]
    }),
  )
}

async function sizes(admin: pg.Pool) {
  const { table, indexes, dead, lsn } = firstRow(
    await admin.query<{ table: string; indexes: string; dead: string; lsn: string }>(
      `SELECT pg_table_size('entries')::text AS table, pg_indexes_size('entries')::text AS indexes,
              coalesce((SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'entries'), 0)::text AS dead,
              pg_current_wal_lsn()::text AS lsn`,
    ),
  )
  return { tableBytes: Number(table), indexBytes: Number(indexes), deadTuples: Number(dead), lsn }
}

async function walBytes(admin: pg.Pool, from: string, to: string): Promise<number> {
  return Number(firstRow(await admin.query<{ bytes: string }>('SELECT pg_wal_lsn_diff($2::pg_lsn, $1::pg_lsn)::text AS bytes', [from, to])).bytes)
}

async function runStep(owner: pg.Pool, sql: string, retries: number): Promise<{ ms: number; retries: number }> {
  const started = performance.now()
  for (let attempt = 0; ; attempt++) {
    const client = await owner.connect()
    try {
      await client.query(sql)
      return { ms: Math.round(performance.now() - started), retries: attempt }
    } catch (error) {
      if ((error as { code?: string }).code !== '55P03' || attempt >= retries) throw error
    } finally {
      client.release()
    }
    await sleep(1000)
  }
}

async function procedure(name: string, base: TestDatabase, accounts: SeedAccounts, dir: string) {
  const db = await createTestDatabase({ template: base.name })
  await db.pool('admin', 1).query(`ALTER DATABASE "${db.name}" SET track_functions = 'pl'`)
  const admin = db.pool('admin', 2)
  const owner = db.pool('ledger_owner', 2)
  const app = createPool({
    connectionString: db.url('ledger_app'),
    max: 16,
    connectionTimeoutMillis: 5000,
    options: '-c transaction_timeout=10000 -c idle_in_transaction_session_timeout=10000',
  })
  const marks: Mark[] = []
  const samples: Sample[] = []
  const steps: Record<string, { ms: number; retries: number }> = {}
  let backfill: BackfillResult | undefined
  try {
    await admin.query('SELECT pg_stat_reset()')
    await admin.query('CHECKPOINT')
    const before = await sizes(admin)
    const load = new Load(
      new PgCtePoster(app, new AccountRegistry(pgAccountLoader(app))),
      accounts,
      Number(values.rate),
      Number(values['max-in-flight']),
      Number(values.seed),
      `e7:${name}`,
    )
    const mark = (what: string) => {
      marks.push({ at: Math.round(load.now()), what })
      console.log(`${name}: ${what} at ${Math.round(load.now() / 1000)} s`)
    }
    let sampling = false
    const sampler = setInterval(() => {
      if (sampling) return
      sampling = true
      const at = load.now()
      admin
        .query<{ longest: number; waiting: number }>(
          `SELECT coalesce(max(extract(epoch FROM clock_timestamp() - query_start)) * 1000, 0)::float8 AS longest, count(*)::int AS waiting
           FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        )
        .then(firstRow)
        .then(({ longest, waiting }) => samples.push({ at: Math.round(at), longestMs: Math.round(longest), waiting }))
        .catch(() => undefined)
        .finally(() => {
          sampling = false
        })
    }, 100)
    load.start()
    mark('load')
    await sleep(Number(values.before) * 1000)
    const baseline = stats(load.requests.filter((r) => r.error === null && r.at >= 5000).map((r) => r.ms))
    const atChange = await functionStats(admin)
    const changeStarted = load.now()
    mark('change')
    if (name === 'naive') {
      const sql = [
        'BEGIN',
        ...[migration('expand'), migration('check'), migration('finish')].map((step) => migrationSql(step).replace("SET lock_timeout = '2s';", '')),
        'COMMIT',
      ].join(';\n')
      steps.all = await runStep(owner, sql, 0)
    } else {
      steps.expand = await runStep(owner, migrationSql(migration('expand')), 10)
      mark('expanded')
      const at = performance.now()
      backfill = await backfillEntryCurrency(owner, {
        batch: Number(values.batch),
        dutyCycle: Number(values.duty),
        pressure: () => load.recentP99(2000) > 2 * baseline.p99,
      })
      steps.backfill = { ms: Math.round(performance.now() - at), retries: 0 }
      mark('backfilled')
      steps.check = await runStep(owner, migrationSql(migration('check')), 10)
      mark('checked')
      steps.validate = await runStep(owner, migrationSql(migration('validate')), 10)
      mark('validated')
      steps.finish = await runStep(owner, migrationSql(migration('finish')), 10)
    }
    const changeEnded = load.now()
    mark('changed')
    const atChanged = await functionStats(admin)
    await sleep(Number(values.after) * 1000)
    await load.stop()
    clearInterval(sampler)
    mark('end')
    const atEnd = await functionStats(admin)
    const after = await sizes(admin)
    const vacuumStarted = performance.now()
    await owner.query('VACUUM entries')
    const vacuumMs = Math.round(performance.now() - vacuumStarted)
    const vacuumed = await sizes(admin)
    const found = values['check-seed'] ? violations(await checkLedger(db.pool('ledger_audit', 1))) : []

    const seconds = Math.ceil(load.now() / 1000)
    const bins = Array.from({ length: seconds }, (_, s) => {
      const inBin = load.requests.filter((r) => Math.floor(r.at / 1000) === s)
      const ok = inBin.filter((r) => r.error === null).map((r) => r.ms)
      const errors: Record<string, number> = {}
      for (const r of inBin) if (r.error !== null) errors[r.error] = (errors[r.error] ?? 0) + 1
      const lock = samples.filter((x) => Math.floor(x.at / 1000) === s)
      return {
        s,
        requests: inBin.length,
        ok: ok.length,
        errors,
        p50: round(stats(ok).p50),
        p99: round(stats(ok).p99),
        longestLockMs: Math.max(0, ...lock.map((x) => x.longestMs)),
        waiting: Math.max(0, ...lock.map((x) => x.waiting)),
      }
    })
    const during = load.requests.filter((r) => r.at >= changeStarted && r.at < changeEnded)
    const duringOk = during.filter((r) => r.error === null).map((r) => r.ms)
    const result = {
      procedure: name,
      changeMs: Math.round(changeEnded - changeStarted),
      steps,
      backfill: backfill && {
        ...backfill,
        through: backfill.through.toString(),
        ms: Math.round(backfill.ms),
        workMs: Math.round(backfill.workMs),
        pausedMs: Math.round(backfill.pausedMs),
      },
      baseline: { p50: round(baseline.p50), p99: round(baseline.p99) },
      duringChange: {
        requests: during.length,
        errors: during.filter((r) => r.error !== null).length,
        errorRate: during.length > 0 ? round((100 * during.filter((r) => r.error !== null).length) / during.length) / 100 : 0,
        p50: round(stats(duringOk).p50),
        p99: round(stats(duringOk).p99),
        max: round(stats(duringOk).max),
      },
      longestLockWaitMs: Math.max(0, ...samples.map((x) => x.longestMs)),
      walBytes: await walBytes(admin, before.lsn, after.lsn),
      sizes: { before, after, vacuumed },
      vacuumMs,
      functions: { beforeChange: perCall({}, atChange), duringChange: perCall(atChange, atChanged), afterChange: perCall(atChanged, atEnd) },
      violations: found,
      marks,
    }
    writeJson(join(dir, `${name}.json`), { ...result, bins })
    console.log(
      `${name}: change ${result.changeMs} ms, ${result.duringChange.errors} errors in ${result.duringChange.requests} requests, p99 ${result.duringChange.p99} ms against ${result.baseline.p99}, longest lock wait ${result.longestLockWaitMs} ms`,
    )
    return result
  } finally {
    await app.end().catch(() => undefined)
    await db.drop()
  }
}

await prepareTemplate()
const dir = createResultsDir(values.out)
const base = await createTestDatabase({ through: BEFORE })
const accounts = await createSeedAccounts(base.pool('ledger_app', 2))
writeJson(join(dir, 'run.json'), {
  experiment: 'e7',
  options: values,
  through: BEFORE,
  steps: STEPS,
  environment: await describeEnvironment(base.pool('admin', 1)),
})
const seedMs = await seedJournals(base.pool('admin', 2), accounts, 0, Number(values.journals), { queueAudit: false })
const seeded = firstRow(
  await base
    .pool('admin', 1)
    .query<{ entries: string; bytes: string }>(`SELECT (SELECT count(*) FROM entries)::text AS entries, pg_database_size(current_database())::text AS bytes`),
)
console.log(`seeded ${seeded.entries} entries in ${Math.round(seedMs / 1000)} s, database ${Math.round(Number(seeded.bytes) / 1e6)} MB`)
const seedFound = values['check-seed'] ? violations(await checkLedger(base.pool('ledger_audit', 1))) : []
if (seedFound.length > 0) throw new Error(`the seed breaks the ledger: ${JSON.stringify(seedFound)}`)
writeJson(join(dir, 'seed.json'), {
  journals: Number(values.journals),
  entries: Number(seeded.entries),
  databaseBytes: Number(seeded.bytes),
  seedMs: Math.round(seedMs),
})
await base.close()
const results = []
try {
  for (const name of values.procedures.split(',')) results.push(await procedure(name, base, accounts, dir))
  writeJson(join(dir, 'summary.json'), results)
} finally {
  await base.drop()
}
console.log(`results in ${dir}`)
process.exit(0)
