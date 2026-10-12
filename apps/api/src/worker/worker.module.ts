import { Module, type DynamicModule } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { HealthController } from '../app.module.ts'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { ErrorFilter } from '../http/api-error.ts'
import { IdempotencyService } from '../idempotency/idempotency.service.ts'
import { Chart } from '../ledger/chart.service.ts'
import { AttemptsService } from '../payments/attempts.service.ts'
import { PspClient } from '../psp/psp.client.ts'
import { WebhooksService } from '../webhooks/webhooks.service.ts'
import { Recovery } from './recovery.service.ts'

@Module({})
export class WorkerModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: WorkerModule,
      controllers: [HealthController],
      providers: [
        { provide: API_CONFIG, useValue: config },
        Database,
        Chart,
        PspClient,
        IdempotencyService,
        AttemptsService,
        WebhooksService,
        Recovery,
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    }
  }
}
