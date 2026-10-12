import { Controller, Get, Module, ValidationPipe, type DynamicModule, type INestApplication } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AccessGuard, Public } from './auth/access.guard.ts'
import { API_CONFIG, type ApiConfig } from './config.ts'
import { Database } from './db/database.ts'
import { ErrorFilter } from './http/api-error.ts'
import { IdempotencyService } from './idempotency/idempotency.service.ts'
import { Chart } from './ledger/chart.service.ts'
import { AttemptsService } from './payments/attempts.service.ts'
import { PaymentsController } from './payments/payments.controller.ts'
import { PaymentsService } from './payments/payments.service.ts'
import { AccountsController, MerchantsController, PayoutsController } from './payouts/payouts.controller.ts'
import { PayoutsService } from './payouts/payouts.service.ts'
import { PspClient } from './psp/psp.client.ts'
import { WebhooksController } from './webhooks/webhooks.controller.ts'
import { WebhooksService } from './webhooks/webhooks.service.ts'

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
    return { ok: true }
  }
}

@Module({})
export class AppModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, PaymentsController, MerchantsController, PayoutsController, AccountsController, WebhooksController],
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
