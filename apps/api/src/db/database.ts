import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { failpoint } from '@carwash/failpoints'
import { withRetry } from '@carwash/ledger'
import { checkout, createPool } from '@carwash/pg'
import pg from 'pg'
import { API_CONFIG, type ApiConfig } from '../config.ts'

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: pg.Pool

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.pool = createPool({
      connectionString: config.databaseUrl,
      max: config.poolSize,
      connectionTimeoutMillis: config.connectTimeoutMs,
      query_timeout: config.transactionTimeoutMs + 2000,
      idle_in_transaction_session_timeout: config.transactionTimeoutMs,
      options: `-c transaction_timeout=${config.transactionTimeoutMs}`,
    })
  }

  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const { value } = await withRetry(async () => {
      const lease = await checkout(this.pool)
      const { client } = lease
      let broken = false
      try {
        await client.query('BEGIN')
        const result = await work(client)
        failpoint('transaction.before_commit')
        await client.query('COMMIT')
        failpoint('transaction.after_commit')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {
          broken = true
        })
        throw error
      } finally {
        lease.release(broken)
      }
    })
    return value
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end()
  }
}
