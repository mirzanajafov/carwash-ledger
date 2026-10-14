import { Controller, Get, Module, ValidationPipe, type DynamicModule, type INestApplication } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AuditController } from './audit/audit.controller.ts'
import { AccessGuard, Public } from './auth/access.guard.ts'
import { API_CONFIG, type ApiConfig } from './config.ts'
import { AuditDatabase, DashboardController } from './dashboard/dashboard.controller.ts'
import { Database } from './db/database.ts'
import { ErrorFilter } from './http/api-error.ts'
import { IdempotencyService } from './idempotency/idempotency.service.ts'
import { Chart } from './ledger/chart.service.ts'
import { LiveController } from './live/live.controller.ts'
import { LiveFeed } from './live/live-feed.ts'
import { AttemptsService } from './payments/attempts.service.ts'
import { PaymentsController } from './payments/payments.controller.ts'
import { PaymentsService } from './payments/payments.service.ts'
import { AccountsController, MerchantsController, PayoutsController } from './payouts/payouts.controller.ts'
import { PayoutsService } from './payouts/payouts.service.ts'
import { PspClient } from './psp/psp.client.ts'
import { ReconciliationController, SettlementsController } from './settlement/settlements.controller.ts'
import { Settlements } from './settlement/settlements.service.ts'
import { WebhooksController } from './webhooks/webhooks.controller.ts'
import { WebhooksService } from './webhooks/webhooks.service.ts'

const STARTED_AT = new Date().toISOString()

@Public()
@Controller('health')
export class HealthController {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  @Get()
  async check() {
    await this.#db.pool.query('SELECT 1')
    return { ok: true, pid: process.pid, started_at: STARTED_AT }
  }
}

@Module({})
export class AppModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        PaymentsController,
        MerchantsController,
        PayoutsController,
        AccountsController,
        WebhooksController,
        SettlementsController,
        ReconciliationController,
        AuditController,
        LiveController,
        DashboardController,
      ],
      providers: [
        { provide: API_CONFIG, useValue: config },
        Database,
        Chart,
        PspClient,
        IdempotencyService,
        AttemptsService,
        PaymentsService,
        PayoutsService,
        WebhooksService,
        Settlements,
        LiveFeed,
        AuditDatabase,
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    }
  }
}

export function configureApp(app: INestApplication, config: ApiConfig): INestApplication {
  const express = app as NestExpressApplication
  express.set('trust proxy', config.trustProxy === 'false' ? false : config.trustProxy.split(','))
  express.useBodyParser('json', { limit: '16kb' })
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  app.enableShutdownHooks()
  return app
}
