import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { AccountRegistry, PgCtePoster, pgAccountLoader, type BalanceMode } from '@carwash/ledger'
import { createTestDatabase, prepareTemplate, type TestDatabase } from '@carwash/testkit'
import { describeEnvironment, median, percentile, writeResults } from './env.ts'
import { mulberry32, runOpenLoop } from './loadgen.ts'
import { runPgbench } from './pgbench.ts'
import { seedCaptureAccounts, type CaptureAccounts } from './seed.ts'
import { pgbenchScript } from './validate-script.ts'

const { values } = parseArgs({
  options: {
    modes: { type: 'string', default: 'locked,derived' },
    connections: { type: 'string', default: '8' },
    rates: { type: 'string', default: '50,100' },
    duration: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '3' },
    repeats: { type: 'string', default: '3' },
    merchants: { type: 'string', default: '1000' },
    out: { type: 'string', default: fileURLToPath(new URL('../results/e1-validate', import.meta.url)) },
  },
})

const durationMs = Number(values.duration) * 1000
const warmupMs = Number(values.warmup) * 1000
const merchantCount = Number(values.merchants)

interface Sample {
  repeat: number
  tool: 'loadgen' | 'pgbench'
  mode: string
  connections: number
  rate: number
  achievedPerSecond: number
  p50Ms: number
  p99Ms: number
  failures: number
}

interface ToolResult {
  achievedPerSecond: number
  p50Ms: number
  p99Ms: number
  failures: number
  lagP99Ms?: number
  cpu?: number
}

async function pgbench(db: TestDatabase, accounts: CaptureAccounts, mode: BalanceMode, connections: number, rate: number) {
  const merchants = accounts.merchants.map(Number)
  const result = await runPgbench({
    url: db.url('ledger_app'),
    script: pgbenchScript(mode),
    rate,
    connections,
    warmupMs,
    durationMs,
    defines: {
      receivable: String(accounts.hot[0].id),
      fees: String(accounts.hot[1].id),
      mlo: String(Math.min(...merchants)),
      mhi: String(Math.max(...merchants)),
    },
  })
  return {
    achievedPerSecond: result.latenciesMs.length / (durationMs / 1000),
    p50Ms: percentile(result.latenciesMs, 50),
    p99Ms: percentile(result.latenciesMs, 99),
    failures: result.failures,
  }
}

async function runLoadgen(db: TestDatabase, accounts: CaptureAccounts, connections: number, rate: number, repeat: number) {
  const app = db.pool('ledger_app', connections)
  const registry = new AccountRegistry(pgAccountLoader(app))
  await registry.resolve([accounts.hot[0].id, accounts.hot[1].id, ...accounts.merchants])
  const poster = new PgCtePoster(app, registry)
  const random = mulberry32(repeat * 31 + rate)
  const result = await runOpenLoop({
    rate,
    durationMs,
    warmupMs,
    seed: repeat * 7 + rate,
    maxInFlight: 10_000,
    task: async (index) => {
      const merchant = accounts.merchants[Math.floor(random() * accounts.merchants.length)]!
      const gross = 500n + BigInt(Math.floor(random() * 3000))
      const fee = gross / 50n + 10n
      await poster.post({
        externalRef: `loadgen:${index}`,
        entries: [
          { accountId: accounts.hot[0].id, amount: gross },
          { accountId: merchant, amount: -(gross - fee) },
          { accountId: accounts.hot[1].id, amount: -fee },
        ],
      })
      return 'ok'
    },
  })
  return {
    achievedPerSecond: result.achievedPerSecond,
    p50Ms: result.latencyMs.p50,
    p99Ms: result.latencyMs.p99,
    failures: result.errors + result.dropped,
    lagP99Ms: result.lagMs.p99,
    cpu: result.generatorCpuPercent,
  }
}

async function main(): Promise<void> {
  await prepareTemplate()
  const probe = await createTestDatabase()
  const env = await describeEnvironment(probe.pool('admin', 1))
  await probe.drop()

  const samples: Sample[] = []
  for (let repeat = 1; repeat <= Number(values.repeats); repeat++) {
    for (const mode of values.modes.split(',') as BalanceMode[]) {
      for (const connections of values.connections.split(',').map(Number)) {
        for (const rate of values.rates.split(',').map(Number)) {
          const tools = repeat % 2 === 1 ? (['loadgen', 'pgbench'] as const) : (['pgbench', 'loadgen'] as const)
          for (const tool of tools) {
            const db = await createTestDatabase()
            try {
              const accounts = await seedCaptureAccounts(db.pool('ledger_app', 1), mode, 1, merchantCount)
              const result: ToolResult =
                tool === 'pgbench'
                  ? await pgbench(db, accounts, mode, connections, rate)
                  : await runLoadgen(db, accounts, connections, rate, repeat)
              samples.push({ repeat, tool, mode, connections, rate, ...result } as Sample)
              console.log(
                `${repeat} ${mode.padEnd(8)} c=${connections} rate ${rate} ${tool.padEnd(8)} ` +
                  `got ${result.achievedPerSecond.toFixed(0)} p50 ${result.p50Ms.toFixed(2)} p99 ${result.p99Ms.toFixed(2)} ms ` +
                  `failures ${result.failures}` +
                  (result.lagP99Ms === undefined ? '' : ` lag99 ${result.lagP99Ms.toFixed(2)} cpu ${result.cpu!.toFixed(0)}%`),
              )
            } finally {
              await db.drop()
            }
          }
        }
      }
    }
  }

  const keys = [...new Set(samples.map((s) => `${s.mode}|${s.connections}|${s.rate}`))]
  const comparison = keys.map((key) => {
    const [mode, connections, rate] = key.split('|')
    const pick = (tool: Sample['tool'], f: (s: Sample) => number) =>
      median(samples.filter((s) => `${s.mode}|${s.connections}|${s.rate}` === key && s.tool === tool).map(f))
    const row = {
      mode,
      connections: Number(connections),
      rate: Number(rate),
      loadgenP50: pick('loadgen', (s) => s.p50Ms),
      pgbenchP50: pick('pgbench', (s) => s.p50Ms),
      loadgenP99: pick('loadgen', (s) => s.p99Ms),
      pgbenchP99: pick('pgbench', (s) => s.p99Ms),
    }
    return { ...row, p50Ratio: row.loadgenP50 / row.pgbenchP50, p99Ratio: row.loadgenP99 / row.pgbenchP99 }
  })
  const file = writeResults(values.out, { env, options: values, comparison, samples })
  console.log(`\nwrote ${file}`)
  console.table(
    comparison.map((c) => ({
      mode: c.mode,
      c: c.connections,
      rate: c.rate,
      'p50 loadgen/pgbench': `${c.loadgenP50.toFixed(2)} / ${c.pgbenchP50.toFixed(2)} (${c.p50Ratio.toFixed(2)})`,
      'p99 loadgen/pgbench': `${c.loadgenP99.toFixed(2)} / ${c.pgbenchP99.toFixed(2)} (${c.p99Ratio.toFixed(2)})`,
    })),
  )
}

await main()
