import { Global, Module, type DynamicModule, type ValueProvider } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { CORE_CONFIG, type CoreConfig } from '../config.ts'
import { AuditDatabase } from '../db/audit-database.ts'
import { Database } from '../db/database.ts'
import { ErrorFilter } from '../http/error.filter.ts'

@Global()
@Module({})
export class CoreModule {
  static register(config: CoreConfig, processConfig: ValueProvider): DynamicModule {
    return {
      module: CoreModule,
      providers: [{ provide: CORE_CONFIG, useValue: config }, processConfig, Database, AuditDatabase, { provide: APP_FILTER, useClass: ErrorFilter }],
      exports: [CORE_CONFIG, processConfig.provide, Database, AuditDatabase],
    }
  }
}
