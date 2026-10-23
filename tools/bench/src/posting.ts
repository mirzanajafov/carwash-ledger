import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { createPrisma, type PrismaClient } from '@carwash/db'
import { median, percentile, pick, writeResults } from '@carwash/lab'
import { AccountRegistry, PgCtePoster, pgAccountLoader, type BalanceMode, type Poster } from '@carwash/ledger'
import { createTestDatabase, prepareTemplate, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { describeEnvironment } from './environment.ts'
import { PrismaApiPoster, PrismaCtePoster, PrismaSqlPoster } from './prisma-posters.ts'

const VARIANTS = ['prisma-api', 'prisma-sql', 'prisma-cte', 'pg-cte'] as const
type Variant = (typeof VARIANTS)[number]

interface Cell {
  variant: Variant
  mode: BalanceMode
  concurrency: number
}

interface Run extends Cell {
  repeat: number
  journals: number
  seconds: number
  journalsPerSecond: number
  p50Ms: number
  p99Ms: number
  maxMs: number
  attemptsPerJournal: number
  roundTripsPerJournal: number
  triggerStatementsPerJournal: number
  statements: StatementCount[]
}

interface StatementCount {
  perJournal: number
  trigger: boolean
  query: string
}

const { values } = parseArgs({
  options: {
    journals: { type: 'string', default: '2000' },
    warmup: { type: 'string', default: '200' },
    concurrency: { type: 'string', default: '1,32' },
    modes: { type: 'string', default: 'locked,derived' },
    variants: { type: 'string', default: VARIANTS.join(',') },
    repeats: { type: 'string', default: '3' },
    merchants: { type: 'string', default: '1000' },
    out: { type: 'string', default: fileURLToPath(new URL('../results/e2', import.meta.url)) },
  },
})

const journals = Number(values.journals)
const warmup = Number(values.warmup)
const merchants = Number(values.merchants)
const repeats = Number(values.repeats)
const cells: Cell[] = []
for (const mode of values.modes.split(',') as BalanceMode[]) {
  for (const concurrency of values.concurrency.split(',').map(Number)) {
    for (const variant of values.variants.split(',') as Variant[]) cells.push({ variant, mode, concurrency })
  }
}

async function seedAccounts(app: pg.Pool, mode: BalanceMode): Promise<{ receivable: bigint; fees: bigint; merchants: bigint[] }> {
  const shards = mode === 'sharded' ? 16 : 1
  const hot = await app.query<{ id: string; code: string }>(
    `INSERT INTO accounts (code, type, currency, balance_mode, shards)
     VALUES ('psp_receivable', 'asset', 'EUR', $1::balance_mode, $2), ('platform_fees', 'revenue', 'EUR', $1::balance_mode, $2)
     RETURNING id::text, code`,
    [mode, shards],
  )
  const rest = await app.query<{ id: string }>(
    `INSERT INTO accounts (code, type, currency, balance_mode)
     SELECT 'merchant_' || n, 'liability', 'EUR', 'locked' FROM generate_series(1, $1::int) AS n
     RETURNING id::text`,
    [merchants],
  )
  await app.query(
    `INSERT INTO balances (account_id, shard)
     SELECT a.id, s FROM accounts a, generate_series(0, a.shards - 1) AS s
     WHERE a.balance_mode <> 'derived'`,
  )
  const byCode = new Map(hot.rows.map((r) => [r.code, BigInt(r.id)]))
  const receivable = byCode.get('psp_receivable')
  const fees = byCode.get('platform_fees')
  if (receivable === undefined || fees === undefined) throw new Error('psp_receivable and platform_fees were not both created')
  return { receivable, fees, merchants: rest.rows.map((r) => BigInt(r.id)) }
}

function makePoster(variant: Variant, app: pg.Pool, prisma: PrismaClient, registry: AccountRegistry): Poster {
  switch (variant) {
    case 'pg-cte':
      return new PgCtePoster(app, registry)
    case 'prisma-api':
      return new PrismaApiPoster(prisma, registry)
    case 'prisma-sql':
      return new PrismaSqlPoster(prisma, registry)
    case 'prisma-cte':
      return new PrismaCtePoster(prisma, registry)
  }
}

async function statements(admin: pg.Pool, db: TestDatabase, journals: number): Promise<StatementCount[]> {
  const result = await admin.query<{ calls: string; query: string }>(
    `SELECT calls::text, regexp_replace(query, '[[:space:]]+', ' ', 'g') AS query
     FROM pg_stat_statements
     WHERE dbid = (SELECT oid FROM pg_database WHERE datname = $1)
       AND userid = (SELECT oid FROM pg_roles WHERE rolname = 'ledger_app')
     ORDER BY calls DESC`,
    [db.name],
  )
  return result.rows.map((r) => ({
    perJournal: Number(r.calls) / journals,
    trigger: r.query.includes('NEW.'),
    query: r.query.slice(0, 160),
  }))
}

async function runCell(cell: Cell, repeat: number): Promise<Run> {
  const db = await createTestDatabase()
  const prisma = createPrisma(db.url('ledger_app'), cell.concurrency + 2)
  try {
    const admin = db.pool('admin', 1)
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements')
    const app = db.pool('ledger_app', cell.concurrency + 2)
    const accounts = await seedAccounts(app, cell.mode)
    const registry = new AccountRegistry(pgAccountLoader(app))
    await registry.resolve([accounts.receivable, accounts.fees, ...accounts.merchants])
    const poster = makePoster(cell.variant, app, prisma, registry)
    let sequence = 0

    const postOne = async () => {
      const n = sequence++
      const merchant = pick(Math.random, accounts.merchants)
      const gross = 500n + BigInt(Math.floor(Math.random() * 3000))
      const fee = gross / 50n + 10n
      return poster.post({
        externalRef: `capture:${repeat}:${n}`,
        entries: [
          { accountId: accounts.receivable, amount: gross },
          { accountId: merchant, amount: -(gross - fee) },
          { accountId: accounts.fees, amount: -fee },
        ],
      })
    }

    const drive = async (count: number, latencies: number[] | null): Promise<number> => {
      let remaining = count
      let attempts = 0
      await Promise.all(
        Array.from({ length: cell.concurrency }, async () => {
          while (remaining > 0) {
            remaining--
            const started = performance.now()
            const posted = await postOne()
            latencies?.push(performance.now() - started)
            attempts += posted.attempts
          }
        }),
      )
      return attempts
    }

    await drive(warmup, null)
    await admin.query('SELECT pg_stat_statements_reset()')
    const latencies: number[] = []
    const started = performance.now()
    const attempts = await drive(journals, latencies)
    const seconds = (performance.now() - started) / 1000
    const counted = await statements(admin, db, journals)
    const sum = (trigger: boolean) => counted.filter((c) => c.trigger === trigger).reduce((t, c) => t + c.perJournal, 0)
    latencies.sort((a, b) => a - b)

    return {
      ...cell,
      repeat,
      journals,
      seconds,
      journalsPerSecond: journals / seconds,
      p50Ms: percentile(latencies, 50),
      p99Ms: percentile(latencies, 99),
      maxMs: latencies.at(-1) ?? Number.NaN,
      attemptsPerJournal: attempts / journals,
      roundTripsPerJournal: sum(false),
      triggerStatementsPerJournal: sum(true),
      statements: counted,
    }
  } finally {
    await prisma.$disconnect()
    await db.drop()
  }
}

async function environment(): Promise<Record<string, unknown>> {
  const db = await createTestDatabase()
  try {
    return await describeEnvironment(db.pool('admin', 1))
  } finally {
    await db.drop()
  }
}

async function main(): Promise<void> {
  await prepareTemplate()
  const env = await environment()
  const runs: Run[] = []
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const offset = (repeat - 1) % cells.length
    const order = [...cells.slice(offset), ...cells.slice(0, offset)]
    for (const cell of order) {
      const run = await runCell(cell, repeat)
      runs.push(run)
      console.log(
        `${repeat} ${cell.mode.padEnd(8)} c=${String(cell.concurrency).padEnd(3)} ${cell.variant.padEnd(11)} ` +
          `${run.journalsPerSecond.toFixed(0).padStart(6)}/s p50 ${run.p50Ms.toFixed(2)} p99 ${run.p99Ms.toFixed(2)} ms ` +
          `round trips ${run.roundTripsPerJournal.toFixed(2)} trigger stmts ${run.triggerStatementsPerJournal.toFixed(2)} ` +
          `attempts ${run.attemptsPerJournal.toFixed(3)}`,
      )
    }
  }

  const summary = cells.map((cell) => {
    const mine = runs.filter((r) => r.variant === cell.variant && r.mode === cell.mode && r.concurrency === cell.concurrency)
    const pick = (f: (r: Run) => number) => ({ median: median(mine.map(f)), min: Math.min(...mine.map(f)), max: Math.max(...mine.map(f)) })
    return {
      ...cell,
      journalsPerSecond: pick((r) => r.journalsPerSecond),
      p50Ms: pick((r) => r.p50Ms),
      p99Ms: pick((r) => r.p99Ms),
      roundTripsPerJournal: pick((r) => r.roundTripsPerJournal),
      triggerStatementsPerJournal: pick((r) => r.triggerStatementsPerJournal),
      attemptsPerJournal: pick((r) => r.attemptsPerJournal),
    }
  })

  const file = writeResults(values.out, { env, options: { journals, warmup, merchants, repeats }, summary, runs })
  console.log(`
wrote ${file}`)
  console.table(
    summary.map((s) => ({
      mode: s.mode,
      c: s.concurrency,
      variant: s.variant,
      'journals/s': `${s.journalsPerSecond.median.toFixed(0)} (${s.journalsPerSecond.min.toFixed(0)}-${s.journalsPerSecond.max.toFixed(0)})`,
      'p50 ms': s.p50Ms.median.toFixed(2),
      'p99 ms': `${s.p99Ms.median.toFixed(2)} (${s.p99Ms.min.toFixed(2)}-${s.p99Ms.max.toFixed(2)})`,
      'round trips': s.roundTripsPerJournal.median.toFixed(2),
      'trigger stmts': s.triggerStatementsPerJournal.median.toFixed(2),
      attempts: s.attemptsPerJournal.median.toFixed(3),
    })),
  )
}

await main()
