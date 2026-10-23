import { writeSync } from 'node:fs'
import { optional, positiveInteger, required } from '@carwash/env'
import { armFailpoints, disarmFailpoints, parseFailpoints } from '@carwash/failpoints'
import {
  AccountRegistry,
  AlreadyReversedError,
  DuplicateJournalError,
  InvalidJournalError,
  LedgerRuleError,
  PgCtePoster,
  pgAccountLoader,
  UnknownAccountError,
} from '@carwash/ledger'
import { createPool } from '@carwash/pg'
import { describeError, type FromWorker, type Outcome, type ToWorker } from './messages.ts'

const pool = createPool({
  connectionString: required(process.env, 'CHAOS_DB_URL'),
  max: positiveInteger(process.env, 'CHAOS_POOL', 8),
  connectionTimeoutMillis: 3000,
  query_timeout: 5000,
})
const poster = new PgCtePoster(pool, new AccountRegistry(pgAccountLoader(pool)))

armFailpoints(parseFailpoints(optional(process.env, 'CHAOS_FAILPOINTS') ?? ''), (name) => {
  writeSync(2, `failpoint ${name}\n`)
  process.kill(process.pid, 'SIGKILL')
})

async function existing(ref: string): Promise<Outcome> {
  try {
    const result = await pool.query<{ id: string }>('SELECT id::text FROM journals WHERE external_ref = $1', [ref])
    const id = result.rows[0]?.id
    return id === undefined ? { kind: 'rejected', error: `${ref} collided with another journal` } : { kind: 'duplicate', journalId: id }
  } catch (error) {
    return { kind: 'retryable', error: describeError(error) }
  }
}

async function post(message: Extract<ToWorker, { type: 'post' }>): Promise<Outcome> {
  try {
    const posted = await poster.post({
      externalRef: message.ref,
      entries: message.entries.map((e) => ({ accountId: BigInt(e.accountId), amount: BigInt(e.amount) })),
      reversesId: message.reversesId === undefined ? undefined : BigInt(message.reversesId),
    })
    return { kind: 'posted', journalId: posted.id.toString(), attempts: posted.attempts }
  } catch (error) {
    if (error instanceof DuplicateJournalError || error instanceof AlreadyReversedError) return existing(message.ref)
    if (error instanceof InvalidJournalError || error instanceof LedgerRuleError || error instanceof UnknownAccountError) {
      return { kind: 'rejected', error: describeError(error) }
    }
    return { kind: 'retryable', error: describeError(error) }
  }
}

function reply(message: FromWorker): void {
  if (process.connected) process.send?.(message)
}

process.on('message', (message: ToWorker) => {
  if (message.type === 'disarm') disarmFailpoints()
  else void post(message).then((outcome) => reply({ type: 'outcome', id: message.id, outcome }))
})
process.on('disconnect', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
