import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { failpoint } from '@carwash/failpoints'
import { createPool, withRetry, withTransaction, type Transaction } from '@carwash/pg'
import pg from 'pg'
import { CORE_CONFIG, type CoreConfig } from '../config.ts'

@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: pg.Pool

  constructor(@Inject(CORE_CONFIG) config: CoreConfig) {
    this.pool = createPool({
      connectionString: config.databaseUrl,
      max: config.poolSize,
      connectionTimeoutMillis: config.connectTimeoutMs,
      query_timeout: config.transactionTimeoutMs + 2000,
      idle_in_transaction_session_timeout: config.transactionTimeoutMs,
      options: `-c transaction_timeout=${config.transactionTimeoutMs}`,
    })
  }

  async transaction<T>(work: (client: Transaction) => Promise<T>): Promise<T> {
    const { value } = await withRetry(async () => {
      const committed = await withTransaction(this.pool, async (client) => {
        const written = await work(client)
        failpoint('transaction.before_commit')
        return written
      })
      failpoint('transaction.after_commit')
      return committed
    })
    return value
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end()
  }
}
