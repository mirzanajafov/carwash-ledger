import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { createPool } from '@carwash/pg'
import type pg from 'pg'
import { API_CONFIG, type ApiConfig } from '../config.ts'

@Injectable()
export class AuditDatabase implements OnModuleDestroy {
  readonly pool: pg.Pool | undefined

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.pool = config.auditDatabaseUrl ? createPool({ connectionString: config.auditDatabaseUrl, max: 2, connectionTimeoutMillis: 5000 }) : undefined
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end()
  }
}
