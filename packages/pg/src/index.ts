import pg from 'pg'

export * from './retry.ts'
export * from './sql-state.ts'

const ignore = () => undefined

export type Queryable = pg.Pool | pg.ClientBase

declare const open: unique symbol

export type Transaction = pg.ClientBase & { readonly [open]: true }

function opened(client: pg.ClientBase): Transaction {
  return client as Transaction
}

const ISOLATION = {
  'read committed': '',
  'repeatable read': 'ISOLATION LEVEL REPEATABLE READ',
  serializable: 'ISOLATION LEVEL SERIALIZABLE',
} as const

export interface TransactionOptions {
  isolation?: keyof typeof ISOLATION
  readOnly?: boolean
}

function begin({ isolation, readOnly }: TransactionOptions): string {
  return ['BEGIN', isolation && ISOLATION[isolation], readOnly && 'READ ONLY'].filter(Boolean).join(' ')
}

export function createPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(config)
  pool.on('error', ignore)
  pool.on('connect', (client) => client.on('error', ignore))
  return pool
}

export function firstRow<R extends pg.QueryResultRow>(result: pg.QueryResult<R>, missing = `expected a row from ${result.command}, got none`): R {
  const [row] = result.rows
  if (row === undefined) throw new Error(missing)
  return row
}

export async function deleteInBatches(batch: number, deleteUpTo: (limit: number) => Promise<pg.QueryResult>): Promise<number> {
  if (!Number.isSafeInteger(batch) || batch < 1) throw new RangeError(`the batch must be a positive integer, not ${batch}`)
  let deleted = 0
  for (;;) {
    const { rowCount } = await deleteUpTo(batch)
    deleted += rowCount ?? 0
    if ((rowCount ?? 0) < batch) return deleted
  }
}

export interface Checkout {
  readonly client: pg.PoolClient
  readonly failed: boolean
  release(broken?: boolean): void
}

export async function checkout(pool: pg.Pool): Promise<Checkout> {
  const client = await pool.connect()
  let failed = false
  const onError = () => {
    failed = true
  }
  client.on('error', onError)
  return {
    client,
    get failed() {
      return failed
    },
    release(broken = false) {
      const destroy = broken || failed
      if (!destroy) client.off('error', onError)
      client.release(destroy)
    },
  }
}

async function within<T>(
  client: pg.ClientBase,
  work: (client: Transaction) => Promise<T>,
  options: TransactionOptions,
  end: 'COMMIT' | 'ROLLBACK',
  onBroken: () => void,
): Promise<T> {
  try {
    await client.query(begin(options))
    const value = await work(opened(client))
    const ended = await client.query(end)
    if (ended.command !== end) throw new Error('the transaction was rolled back at COMMIT because a statement in it had failed')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(onBroken)
    throw error
  }
}

async function transaction<T>(pool: pg.Pool, work: (client: Transaction) => Promise<T>, options: TransactionOptions, end: 'COMMIT' | 'ROLLBACK'): Promise<T> {
  const lease = await checkout(pool)
  let broken = false
  try {
    return await within(lease.client, work, options, end, () => {
      broken = true
    })
  } finally {
    lease.release(broken)
  }
}

export function withTransaction<T>(pool: pg.Pool, work: (client: Transaction) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
  return transaction(pool, work, options, 'COMMIT')
}

export function inRollback<T>(pool: pg.Pool, work: (client: Transaction) => Promise<T>): Promise<T> {
  return transaction(pool, work, {}, 'ROLLBACK')
}

export function inSnapshot<T>(pool: pg.Pool, read: (client: Transaction) => Promise<T>): Promise<T> {
  return withTransaction(pool, read, { isolation: 'repeatable read', readOnly: true })
}

export function inTransaction<T>(client: pg.ClientBase, work: (client: Transaction) => Promise<T>): Promise<T> {
  return within(client, work, {}, 'COMMIT', ignore)
}

export async function takeAdvisoryLock(client: Transaction, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key])
}

export async function withAdvisoryLock<T>(pool: pg.Pool, key: string, work: (client: pg.ClientBase) => Promise<T>): Promise<T> {
  const lease = await checkout(pool)
  let locked = false
  try {
    await lease.client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key])
    locked = true
    return await work(lease.client)
  } finally {
    const unlocked =
      locked &&
      (await lease.client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).then(
        () => true,
        () => false,
      ))
    lease.release(!unlocked)
  }
}
