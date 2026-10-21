import pg from 'pg'

const ignore = () => undefined

export function createPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(config)
  pool.on('error', ignore)
  pool.on('connect', (client) => client.on('error', ignore))
  return pool
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

export async function inSnapshot<T>(pool: pg.Pool, read: (client: pg.ClientBase) => Promise<T>): Promise<T> {
  const lease = await checkout(pool)
  const { client } = lease
  let broken = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const value = await read(client)
    await client.query('COMMIT')
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
