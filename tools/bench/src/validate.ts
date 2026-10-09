import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { AccountRegistry, PgCtePoster, pgAccountLoader, type BalanceMode } from '@carwash/ledger'
import { createTestDatabase, prepareTemplate, type TestDatabase } from '@carwash/testkit'
import { describeEnvironment, median, percentile, writeResults } from './env.ts'
import { mulberry32, runOpenLoop } from './loadgen.ts'
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

async function runPgbench(db: TestDatabase, accounts: CaptureAccounts, mode: BalanceMode, connections: number, rate: number) {
  const script = join(tmpdir(), `capture-${mode}.sql`)
  writeFileSync(script, pgbenchScript(mode))
  const url = new URL(db.url('ledger_app'))
  const prefix = join(tmpdir(), `pgb-${process.pid}-${Date.now()}`)
  const merchants = accounts.merchants.map(Number)
  const args = [
    '-n', '-M', 'extended', '-f', script,
    '-R', String(rate), '-c', String(connections), '-j', String(Math.min(4, connections)),
    '-T', String(Math.round((warmupMs + durationMs) / 1000)),
    '--log', `--log-prefix=${prefix}`,
    '-D', `receivable=${accounts.hot[0].id}`, '-D', `fees=${accounts.hot[1].id}`,
    '-D', `mlo=${Math.min(...merchants)}`, '-D', `mhi=${Math.max(...merchants)}`,
    url.pathname.slice(1),
  ]
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  }
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('pgbench', args, { env })
    let text = ''
    child.stdout.on('data', (d) => (text += d))
    child.stderr.on('data', (d) => (text += d))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`pgbench exited ${code}: ${text}`))))
  })

  const base = prefix.split('/').at(-1)!
  const files = readdirSync(tmpdir()).filter((f) => f.startsWith(base))
  const rows: { epochUs: number; latencyUs: number }[] = []
  let failures = 0
  for (const file of files) {
    for (const line of readFileSync(join(tmpdir(), file), 'utf8').split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 7) continue
      if (parts[2] === 'skipped' || parts[2] === 'failed') {
        failures++
        continue
      }
      rows.push({
        epochUs: Number(parts[4]) * 1e6 + Number(parts[5]),
        latencyUs: Number(parts[2]) + Number(parts[6]),
      })
    }
    rmSync(join(tmpdir(), file))
  }
  rmSync(script)
  const start = Math.min(...rows.map((r) => r.epochUs - r.latencyUs))
  const measured = rows.filter((r) => r.epochUs - r.latencyUs >= start + warmupMs * 1000).map((r) => r.latencyUs / 1000)
  measured.sort((a, b) => a - b)
  return {
    achievedPerSecond: measured.length / (durationMs / 1000),
    p50Ms: percentile(measured, 50),
    p99Ms: percentile(measured, 99),
    failures,
    output,
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
              const result =
                tool === 'pgbench'
                  ? await runPgbench(db, accounts, mode, connections, rate)
                  : await runLoadgen(db, accounts, connections, rate, repeat)
              samples.push({ repeat, tool, mode, connections, rate, ...result } as Sample)
              console.log(
                `${repeat} ${mode.padEnd(8)} c=${connections} rate ${rate} ${tool.padEnd(8)} ` +
                  `got ${result.achievedPerSecond.toFixed(0)} p50 ${result.p50Ms.toFixed(2)} p99 ${result.p99Ms.toFixed(2)} ms ` +
                  `failures ${result.failures}` +
                  ('lagP99Ms' in result ? ` lag99 ${result.lagP99Ms.toFixed(2)} cpu ${result.cpu.toFixed(0)}%` : ''),
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
