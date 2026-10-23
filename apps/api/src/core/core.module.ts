import { Global, Module, type DynamicModule } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { CORE_CONFIG, type API_CONFIG, type ApiConfig, type CoreConfig, type WORKER_CONFIG, type WorkerConfig } from '../config.ts'
import { AuditDatabase } from '../db/audit-database.ts'
import { Database } from '../db/database.ts'
import { ErrorFilter } from '../http/error.filter.ts'

@Global()
@Module({})
export class CoreModule {
  static register(
    config: CoreConfig,
    processConfig: { provide: typeof API_CONFIG; useValue: ApiConfig } | { provide: typeof WORKER_CONFIG; useValue: WorkerConfig },
  ): DynamicModule {
    return {
      module: CoreModule,
      providers: [{ provide: CORE_CONFIG, useValue: config }, processConfig, Database, AuditDatabase, { provide: APP_FILTER, useClass: ErrorFilter }],
      exports: [CORE_CONFIG, processConfig.provide, Database, AuditDatabase],
    }
  }
}
