import { parseArgs } from 'node:util'
import { backfillEntryCurrency, createPool } from '@carwash/ledger'
import { firstRow } from '@carwash/pg'

const { values } = parseArgs({
  options: {
    batch: { type: 'string', default: '5000' },
    duty: { type: 'string', default: '0.5' },
  },
})
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  process.stderr.write('usage: backfill-entry-currency [--batch 5000] [--duty 0.5]   (DATABASE_URL must be the owner role)\n')
  process.exit(2)
}

const pool = createPool({ connectionString, max: 2 })
const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort())
try {
  let reported = performance.now()
  const result = await backfillEntryCurrency(pool, {
    batch: Number(values.batch),
    dutyCycle: Number(values.duty),
    signal: stop.signal,
    onBatch: (batch) => {
      if (performance.now() - reported < 10_000) return
      reported = performance.now()
      process.stderr.write(`through entry ${batch.to}, last batch ${batch.updated} rows in ${Math.round(batch.ms)} ms\n`)
    },
  })
  const left = Number(firstRow(await pool.query<{ left: string }>('SELECT count(*)::text AS left FROM entries WHERE currency IS NULL')).left)
  process.stdout.write(
    `${JSON.stringify({ ...result, through: result.through.toString(), ms: Math.round(result.ms), workMs: Math.round(result.workMs), pausedMs: Math.round(result.pausedMs), left }, null, 2)}\n`,
  )
  process.exitCode = left === 0 ? 0 : 1
} finally {
  await pool.end()
}
