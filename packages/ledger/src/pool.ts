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
