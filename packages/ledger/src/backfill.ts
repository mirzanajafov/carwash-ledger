import { setTimeout as sleep } from 'node:timers/promises'
import type pg from 'pg'

export interface BackfillBatch {
  from: bigint
  to: bigint
  updated: number
  ms: number
}

export interface BackfillOptions {
  batch?: number
  dutyCycle?: number
  pressure?: () => boolean | Promise<boolean>
  onBatch?: (batch: BackfillBatch) => void
  signal?: AbortSignal
}

export interface BackfillResult {
  batches: number
  updated: number
  ms: number
  workMs: number
  pausedMs: number
  through: bigint
  done: boolean
}

const WAITING = `
  SELECT count(*)::int AS waiting FROM pg_locks
  WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`

const BATCH = `
  UPDATE entries e SET currency = a.currency
  FROM accounts a
  WHERE e.id >= $1 AND e.id < $2 AND e.currency IS NULL AND a.id = e.account_id`

export async function backfillEntryCurrency(pool: pg.Pool, options: BackfillOptions = {}): Promise<BackfillResult> {
  const size = BigInt(options.batch ?? 5000)
  const duty = options.dutyCycle ?? 0.5
  if (!(duty > 0 && duty <= 1)) throw new RangeError('the duty cycle is a fraction in (0, 1]')
  const started = performance.now()
  const { rows } = await pool.query<{ lo: string | null; hi: string | null }>('SELECT min(id)::text AS lo, max(id)::text AS hi FROM entries')
  const result: BackfillResult = { batches: 0, updated: 0, ms: 0, workMs: 0, pausedMs: 0, through: 0n, done: false }
  if (rows[0]!.lo === null) return { ...result, done: true }
  const last = BigInt(rows[0]!.hi!)
  for (let from = BigInt(rows[0]!.lo!); from <= last; from += size) {
    if (options.signal?.aborted) break
    const pausedAt = performance.now()
    while ((await pool.query<{ waiting: number }>(WAITING)).rows[0]!.waiting > 0 || (await options.pressure?.())) {
      if (options.signal?.aborted) break
      await sleep(100)
    }
    result.pausedMs += performance.now() - pausedAt
    if (options.signal?.aborted) break
    const to = from + size
    const at = performance.now()
    const updated = (await pool.query(BATCH, [from.toString(), to.toString()])).rowCount ?? 0
    const ms = performance.now() - at
    result.batches++
    result.updated += updated
    result.workMs += ms
    result.through = to - 1n
    options.onBatch?.({ from, to: to - 1n, updated, ms })
    if (duty < 1) {
      const rest = (ms * (1 - duty)) / duty
      await sleep(rest)
      result.pausedMs += rest
    }
  }
  result.done = result.through >= last
  result.ms = performance.now() - started
  return result
}
