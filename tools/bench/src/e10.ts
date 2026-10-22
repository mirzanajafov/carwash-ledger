import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { verifyLog } from '@carwash/audit-pg'
import { createPool, inSnapshot } from '@carwash/pg'
import { createTestDatabase, prepareTemplate } from '@carwash/testkit'
import { appendJsonLine, createResultsDir, describeEnvironment, median, writeJson } from './env.ts'
import { seedProductionLedger } from './production-seed.ts'

const { values } = parseArgs({
  options: {
    days: { type: 'string', default: '7' },
    'per-day': { type: 'string', default: '17400' },
    'leaves-per-checkpoint': { type: 'string', default: '2.476' },
    batches: { type: 'string', default: '5000,1000' },
    repeats: { type: 'string', default: '3' },
    out: { type: 'string', default: 'results/e10' },
  },
})

const ms = (ns: number) => Math.round(ns / 1e4) / 100

await prepareTemplate()
const dir = createResultsDir(values.out)
const db = await createTestDatabase()
try {
  const admin = db.pool('admin', 2)
  writeJson(join(dir, 'run.json'), { experiment: 'e10', options: values, environment: await describeEnvironment(admin) })
  const ledger = await seedProductionLedger(admin, db.pool('ledger_app', 2), {
    days: Number(values.days),
    paymentsPerDay: Number(values['per-day']),
    leavesPerCheckpoint: Number(values['leaves-per-checkpoint']),
  })
  console.log(`seeded ${values.days} days: ${ledger.journals} journals, ${ledger.checkpoints} copies`)
  const pool = createPool({ connectionString: db.url('ledger_audit'), max: 2, options: '-c jit=off' })
  try {
    for (const batch of values.batches.split(',').map(Number)) {
      const runs = []
      for (let r = 0; r < Number(values.repeats); r++) {
        const delay = monitorEventLoopDelay({ resolution: 10 })
        const cpu = process.cpuUsage()
        delay.enable()
        const report = await inSnapshot(pool, (client) => verifyLog(client, { witness: ledger.witness, batch }))
        delay.disable()
        if (report.findings > 0) throw new Error(`the verifier found something in the seed: ${JSON.stringify(report.examples)}`)
        const used = process.cpuUsage(cpu)
        runs.push({
          totalMs: report.ms.total,
          cpuMs: Math.round((used.user + used.system) / 1000),
          delayMs: { p50: ms(delay.percentile(50)), p99: ms(delay.percentile(99)), max: ms(delay.max) },
        })
      }
      const step = {
        batch,
        journals: ledger.journals,
        copies: ledger.checkpoints,
        runs,
        totalMsMedian: median(runs.map((run) => run.totalMs)),
        delayMaxMsMedian: median(runs.map((run) => run.delayMs.max)),
        delayP99MsMedian: median(runs.map((run) => run.delayMs.p99)),
      }
      appendJsonLine(join(dir, 'e10.jsonl'), step)
      console.log(JSON.stringify(step))
    }
  } finally {
    await pool.end()
  }
} finally {
  await db.drop()
}
console.log(`results in ${dir}`)
process.exit(0)
