import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { verifyLog, type VerifyReport } from '@carwash/audit-pg'
import { checkAudit, checkLedger, checkPaymentsIn, checkSequenced, inSnapshot, violations, type InvariantResult } from '@carwash/invariants'
import { createPool } from '@carwash/pg'
import { createTestDatabase, prepareTemplate, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { appendJsonLine, createResultsDir, describeEnvironment, median, writeJson } from './env.ts'
import { seedProductionLedger, type ProductionLedger } from './production-seed.ts'

const { values } = parseArgs({
  options: {
    days: { type: 'string', default: '6.6,66' },
    'per-day': { type: 'string', default: '17400' },
    'leaves-per-checkpoint': { type: 'string', default: '2.476' },
    repeats: { type: 'string', default: '3' },
    out: { type: 'string', default: 'results/e8' },
  },
})

interface Query {
  sql: string
  ms: number
}

function recording(client: pg.ClientBase, queries: Query[]): pg.ClientBase {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'query') {
        return async (...args: unknown[]) => {
          const started = performance.now()
          try {
            return await (target.query as (...a: unknown[]) => Promise<unknown>)(...args)
          } finally {
            queries.push({ sql: String(args[0]).replace(/\s+/g, ' ').trim().slice(0, 90), ms: Math.round(performance.now() - started) })
          }
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now()
  const value = await work()
  return { value, ms: Math.round(performance.now() - started) }
}

async function checks(pool: pg.Pool, ledger: ProductionLedger) {
  const queries: Query[] = []
  const s1s2 = await timed(() => checkLedger(pool))
  const payments = await timed(() => inSnapshot(pool, (client) => checkPaymentsIn(recording(client, queries))))
  const s7 = await timed(() => checkAudit(pool, ledger.witness))
  const l4 = await timed(() => checkSequenced(pool, undefined, { graceSeconds: 10 }))
  const results: InvariantResult[] = [...s1s2.value, ...payments.value, s7.value, l4.value]
  return {
    ms: { s1s2: s1s2.ms, s3s5s6: payments.ms, s7: s7.ms, l4: l4.ms, total: s1s2.ms + payments.ms + s7.ms + l4.ms },
    queries,
    broken: violations(results),
  }
}

async function verify(pool: pg.Pool, ledger: ProductionLedger, witnessed: boolean): Promise<VerifyReport> {
  return inSnapshot(pool, (client) => verifyLog(client, witnessed ? { witness: ledger.witness } : {}))
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
      const runs: Record<'on' | 'off', Awaited<ReturnType<typeof checks>>[]> = { on: [], off: [] }
      for (let r = 0; r < repeats; r++) {
        for (const jit of ['on', 'off'] as const) runs[jit].push(await checks(pools[jit], ledger))
      }
      const verified: VerifyReport[] = []
      for (let r = 0; r < repeats; r++) verified.push(await verify(pools.off, ledger, true))
      if (verified.some((v) => v.findings > 0)) throw new Error(`the verifier found something in the seed: ${JSON.stringify(verified[0]!.examples)}`)
      const unwitnessed = await verify(pools.off, ledger, false)
      const medians = (jit: 'on' | 'off') =>
        Object.fromEntries(Object.keys(runs[jit][0]!.ms).map((key) => [key, median(runs[jit].map((run) => run.ms[key as keyof typeof run.ms]))]))
      const step = {
        days,
        payments: ledger.payments,
        journals: ledger.journals,
        copies: ledger.checkpoints,
        seedMs: ledger.ms,
        bytes: await sizes(admin),
        checks: { jitOn: medians('on'), jitOff: medians('off') },
        queries: { jitOn: runs.on.at(-1)!.queries, jitOff: runs.off.at(-1)!.queries },
        verify: verified.map((v) => ({ ...v.ms, journals: v.journals, witnessed: v.witnessed })),
        verifyMedianMs: median(verified.map((v) => v.ms.total)),
        verifyWithoutWitnessMs: unwitnessed.ms,
      }
      appendJsonLine(join(dir, 'e8.jsonl'), step)
      console.log(JSON.stringify({ days, checks: step.checks, verifyMedianMs: step.verifyMedianMs, verifyWithoutWitnessMs: step.verifyWithoutWitnessMs }))
    } finally {
      await Promise.all([pools.on.end(), pools.off.end()])
    }
  } finally {
    await db.drop()
  }
}

await prepareTemplate()
const dir = createResultsDir(values.out!)
const probe = await createTestDatabase()
writeJson(join(dir, 'run.json'), { experiment: 'e8', options: values, environment: await describeEnvironment(probe.pool('admin', 1)) })
await probe.drop()
for (const days of values.days!.split(',').map(Number)) await measure(dir, days, Number(values.repeats))
console.log(`results in ${dir}`)
process.exit(0)
