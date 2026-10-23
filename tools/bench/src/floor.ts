import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { percentile, writeResults } from '@carwash/lab'
import { createTestDatabase, prepareTemplate } from '@carwash/testkit'
import { describeEnvironment } from './environment.ts'
import { runPgbench } from './pgbench.ts'

const { values } = parseArgs({
  options: {
    rate: { type: 'string', default: '100' },
    connections: { type: 'string', default: '8' },
    duration: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '3' },
    repeats: { type: 'string', default: '2' },
    out: { type: 'string', default: fileURLToPath(new URL('../results/floor', import.meta.url)) },
  },
})

const SCRIPTS = {
  select: 'SELECT 1;\n',
  commit: '\\set id random(1, 100000)\nBEGIN;\nUPDATE floor SET v = v + 1 WHERE id = :id;\nCOMMIT;\n',
}

async function main(): Promise<void> {
  await prepareTemplate()
  const durationMs = Number(values.duration) * 1000
  const runs = []
  let env: Record<string, unknown> | undefined
  for (let repeat = 1; repeat <= Number(values.repeats); repeat++) {
    for (const [name, script] of Object.entries(SCRIPTS)) {
      const db = await createTestDatabase()
      try {
        const admin = db.pool('admin', 1)
        env ??= await describeEnvironment(admin)
        await admin.query('CREATE TABLE floor (id int PRIMARY KEY, v bigint NOT NULL DEFAULT 0)')
        await admin.query('INSERT INTO floor (id) SELECT generate_series(1, 100000)')
        await admin.query('VACUUM ANALYZE floor')
        const result = await runPgbench({
          url: db.url('admin'),
          script,
          rate: Number(values.rate),
          connections: Number(values.connections),
          warmupMs: Number(values.warmup) * 1000,
          durationMs,
        })
        const ms = result.latenciesMs
        const run = {
          repeat,
          script: name,
          count: ms.length,
          failures: result.failures,
          p50: percentile(ms, 50),
          p90: percentile(ms, 90),
          p99: percentile(ms, 99),
          p999: percentile(ms, 99.9),
          max: ms.at(-1) ?? Number.NaN,
          over50ms: ms.filter((x) => x > 50).length / Math.max(1, ms.length),
        }
        runs.push(run)
        console.log(
          `${repeat} ${name.padEnd(6)} n ${run.count} p50 ${run.p50.toFixed(2)} p90 ${run.p90.toFixed(2)} ` +
            `p99 ${run.p99.toFixed(2)} p99.9 ${run.p999.toFixed(2)} max ${run.max.toFixed(1)} ms ` +
            `over 50 ms ${(run.over50ms * 100).toFixed(2)}%`,
        )
      } finally {
        await db.drop()
      }
    }
  }
  console.log(`\nwrote ${writeResults(values.out, { env, options: values, runs })}`)
}

await main()
