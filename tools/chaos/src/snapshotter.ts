import { writeSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { nonNegativeInteger, optional, required } from '@carwash/env'
import { armFailpoints, disarmFailpoints, parseFailpoints } from '@carwash/failpoints'
import { takeSnapshots } from '@carwash/ledger'
import { createPool } from '@carwash/pg'
import { describeError, type FromWorker, type ToWorker } from './messages.ts'

const pool = createPool({
  connectionString: required(process.env, 'CHAOS_DB_URL'),
  max: 1,
  connectionTimeoutMillis: 3000,
  query_timeout: 5000,
})
const everyMs = nonNegativeInteger(process.env, 'CHAOS_SNAPSHOT_MS', 100)

armFailpoints(parseFailpoints(optional(process.env, 'CHAOS_FAILPOINTS') ?? ''), (name) => {
  writeSync(2, `failpoint ${name}\n`)
  process.kill(process.pid, 'SIGKILL')
})

function report(message: FromWorker): void {
  if (process.connected) process.send?.(message)
}

process.on('message', (message: ToWorker) => {
  if (message.type === 'disarm') disarmFailpoints()
})
process.on('disconnect', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

for (;;) {
  try {
    const run = await takeSnapshots(pool)
    if (run !== null) report({ type: 'snapshot', accounts: run.accounts })
  } catch (error) {
    report({ type: 'snapshot-error', error: describeError(error) })
  }
  await sleep(everyMs)
}
