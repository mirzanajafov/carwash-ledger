import { Global, Module, type DynamicModule } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { AuditDatabase } from '../db/audit-database.ts'
import { Database } from '../db/database.ts'
import { ErrorFilter } from '../http/error.filter.ts'

@Global()
@Module({})
export class CoreModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [{ provide: API_CONFIG, useValue: config }, Database, AuditDatabase, { provide: APP_FILTER, useClass: ErrorFilter }],
      exports: [API_CONFIG, Database, AuditDatabase],
    }
  }
}
