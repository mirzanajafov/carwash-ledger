import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { verifyLog, type VerifyReport } from '@carwash/audit-pg'
import { checkAudit, checkLedger, checkPaymentsIn, checkSequenced, violations, type InvariantResult, type WitnessView } from '@carwash/invariants'
import { appendJsonLine, createResultsDir, median, writeJson } from '@carwash/lab'
import { createPool, inSnapshot } from '@carwash/pg'
import { createTestDatabase, prepareTemplate, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { describeEnvironment } from './environment.ts'
import { addTraffic, seedProductionLedger, type ProductionLedger } from './production-seed.ts'

const { values } = parseArgs({
  options: {
    days: { type: 'string', default: '6.6,66' },
    'per-day': { type: 'string', default: '17400' },
    'leaves-per-checkpoint': { type: 'string', default: '2.476' },
    repeats: { type: 'string', default: '3' },
    out: { type: 'string', default: 'results/e8' },
  },
})

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now()
  const value = await work()
  return { value, ms: Math.round(performance.now() - started) }
}

interface CheckTimes {
  s1s2: number
  s3s5s6: number
  s7: number
  l4: number
  total: number
}

async function checks(pool: pg.Pool, ledger: ProductionLedger): Promise<{ ms: CheckTimes; broken: InvariantResult[] }> {
  const s1s2 = await timed(() => checkLedger(pool))
  const payments = await timed(async () => (await inSnapshot(pool, (client) => checkPaymentsIn(client))).results)
  const s7 = await timed(() => checkAudit(pool, ledger.witness))
  const l4 = await timed(() => checkSequenced(pool, undefined, { graceSeconds: 10 }))
  return {
    ms: { s1s2: s1s2.ms, s3s5s6: payments.ms, s7: s7.ms, l4: l4.ms, total: s1s2.ms + payments.ms + s7.ms + l4.ms },
    broken: violations([...s1s2.value, ...payments.value, s7.value, l4.value]),
  }
}

function medianTimes(runs: readonly CheckTimes[]): CheckTimes {
  const of = (key: keyof CheckTimes) => median(runs.map((run) => run[key]))
  return { s1s2: of('s1s2'), s3s5s6: of('s3s5s6'), s7: of('s7'), l4: of('l4'), total: of('total') }
}

const INCREMENTS = [
  ['10 s', 10],
  ['1 minute', 60],
  ['1 hour', 3600],
] as const

async function incremental(admin: pg.Pool, pool: pg.Pool, ledger: ProductionLedger, repeats: number) {
  let base = (await inSnapshot(pool, (client) => checkPaymentsIn(client))).base
  const steps = []
  for (const [traffic, seconds] of INCREMENTS) {
    const payments = Math.max(1, Math.round((Number(values['per-day']) * seconds) / 86_400))
    await addTraffic(admin, ledger.traffic, payments)
    const since = base
    const runs: number[] = []
    let last
    for (let r = 0; r < repeats; r++) {
      const run = await timed(() => inSnapshot(pool, (client) => checkPaymentsIn(client, { since })))
      runs.push(run.ms)
      last = run.value
    }
    if (!last?.since || !last.base)
      throw new Error(`the incremental checks after ${traffic} of traffic did not continue cleanly: ${JSON.stringify(last?.results)}`)
    steps.push({ traffic, added: payments, ms: median(runs), payments: last.payments, entries: last.entries })
    base = last.base
  }
  return steps
}

async function verify(pool: pg.Pool, witness: WitnessView | undefined): Promise<VerifyReport> {
  return inSnapshot(pool, (client) => verifyLog(client, { witness }))
}

async function sizes(admin: pg.Pool) {
  const { rows } = await admin.query<{ name: string; mb: number }>(
    `SELECT relname AS name, round(pg_total_relation_size(oid) / 1048576.0)::int AS mb FROM pg_class
     WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND pg_total_relation_size(oid) > 1048576 ORDER BY 2 DESC`,
  )
  return Object.fromEntries(rows.map((r) => [r.name, r.mb]))
}

async function measure(dir: string, days: number, repeats: number) {
  const db: TestDatabase = await createTestDatabase()
  try {
    const admin = db.pool('admin', 2)
    const ledger = await seedProductionLedger(admin, db.pool('ledger_app', 2), {
      days,
      paymentsPerDay: Number(values['per-day']),
      leavesPerCheckpoint: Number(values['leaves-per-checkpoint']),
    })
    console.log(
      `seeded ${days} days: ${ledger.payments} payments, ${ledger.journals} journals, ${ledger.checkpoints} copies in ${JSON.stringify(ledger.ms)} ms`,
    )
    const pools = {
      on: createPool({ connectionString: db.url('ledger_audit'), max: 2 }),
      off: createPool({ connectionString: db.url('ledger_audit'), max: 2, options: '-c jit=off' }),
    }
    try {
      const first = await checks(pools.off, ledger)
      if (first.broken.length > 0) throw new Error(`the seed breaks invariants: ${JSON.stringify(first.broken)}`)
      const runs: Record<'on' | 'off', CheckTimes[]> = { on: [], off: [] }
      for (let r = 0; r < repeats; r++) {
        for (const jit of ['on', 'off'] as const) runs[jit].push((await checks(pools[jit], ledger)).ms)
      }
      const verified: VerifyReport[] = []
      for (let r = 0; r < repeats; r++) verified.push(await verify(pools.off, ledger.witness))
      const wrong = verified.find((v) => v.findings > 0)
      if (wrong) throw new Error(`the verifier found something in the seed: ${JSON.stringify(wrong.examples)}`)
      const unwitnessed = await verify(pools.off, undefined)
      const resumed = { jitOn: await incremental(admin, pools.on, ledger, repeats), jitOff: await incremental(admin, pools.off, ledger, repeats) }
      const step = {
        days,
        payments: ledger.payments,
        journals: ledger.journals,
        copies: ledger.checkpoints,
        seedMs: ledger.ms,
        bytes: await sizes(admin),
        checks: { jitOn: medianTimes(runs.on), jitOff: medianTimes(runs.off) },
        verify: verified.map((v) => ({ ...v.ms, journals: v.journals, witnessed: v.witnessed })),
        verifyMedianMs: median(verified.map((v) => v.ms.total)),
        verifyWithoutWitnessMs: unwitnessed.ms,
        incremental: resumed,
      }
      appendJsonLine(join(dir, 'e8.jsonl'), step)
      console.log(JSON.stringify({ days, checks: step.checks, verifyMedianMs: step.verifyMedianMs, incremental: resumed }))
    } finally {
      await Promise.all([pools.on.end(), pools.off.end()])
    }
  } finally {
    await db.drop()
  }
}

await prepareTemplate()
const dir = createResultsDir(values.out)
const probe = await createTestDatabase()
writeJson(join(dir, 'run.json'), { experiment: 'e8', options: values, environment: await describeEnvironment(probe.pool('admin', 1)) })
await probe.drop()
for (const days of values.days.split(',').map(Number)) await measure(dir, days, Number(values.repeats))
console.log(`results in ${dir}`)
process.exit(0)
