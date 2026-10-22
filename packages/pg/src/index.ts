import pg from 'pg'

const ignore = () => undefined

export type Queryable = pg.Pool | pg.ClientBase

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

export function firstRow<R extends pg.QueryResultRow>(result: pg.QueryResult<R>): R {
  const [row] = result.rows
  if (row === undefined) throw new Error(`expected a row from ${result.command}, got none`)
  return row
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

async function transaction<T>(pool: pg.Pool, work: (client: pg.ClientBase) => Promise<T>, options: TransactionOptions, end: 'COMMIT' | 'ROLLBACK'): Promise<T> {
  const lease = await checkout(pool)
  const { client } = lease
  let broken = false
  try {
    await client.query(begin(options))
    const value = await work(client)
    const ended = await client.query(end)
    if (ended.command !== end) throw new Error('the transaction was rolled back at COMMIT because a statement in it had failed')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      broken = true
    })
    throw error
  } finally {
    lease.release(broken)
  }
}

export function withTransaction<T>(pool: pg.Pool, work: (client: pg.ClientBase) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
  return transaction(pool, work, options, 'COMMIT')
}

export function inRollback<T>(pool: pg.Pool, work: (client: pg.ClientBase) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
  return transaction(pool, work, options, 'ROLLBACK')
}

export function inSnapshot<T>(pool: pg.Pool, read: (client: pg.ClientBase) => Promise<T>): Promise<T> {
  return withTransaction(pool, read, { isolation: 'repeatable read', readOnly: true })
}
