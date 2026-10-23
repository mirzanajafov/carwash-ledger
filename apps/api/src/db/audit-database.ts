import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { createPool } from '@carwash/pg'
import type pg from 'pg'
import { CORE_CONFIG, type CoreConfig } from '../config.ts'

@Injectable()
export class AuditDatabase implements OnModuleDestroy {
  readonly pool: pg.Pool | undefined

  constructor(@Inject(CORE_CONFIG) config: CoreConfig) {
    this.pool = config.auditDatabaseUrl ? createPool({ connectionString: config.auditDatabaseUrl, max: 2, connectionTimeoutMillis: 5000 }) : undefined
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end()
  }
}
