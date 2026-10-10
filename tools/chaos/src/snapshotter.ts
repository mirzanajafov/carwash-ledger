import { writeSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { armFailpoints, createPool, disarmFailpoints, parseFailpoints, takeSnapshots } from '@carwash/ledger'
import { describeError, type FromWorker, type ToWorker } from './messages.ts'

const pool = createPool({
  connectionString: process.env.CHAOS_DB_URL,
  max: 1,
  connectionTimeoutMillis: 3000,
  query_timeout: 5000,
})
const everyMs = Number(process.env.CHAOS_SNAPSHOT_MS ?? 100)

armFailpoints(parseFailpoints(process.env.CHAOS_FAILPOINTS ?? ''), (name) => {
  writeSync(2, `failpoint ${name}\n`)
  process.kill(process.pid, 'SIGKILL')
})

function report(message: FromWorker): void {
  if (process.connected) process.send!(message)
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
