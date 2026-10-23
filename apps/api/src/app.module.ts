import { Module, ValidationPipe, type DynamicModule } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AccountsModule } from './accounts/accounts.module.ts'
import { AuditApiModule } from './audit/audit-api.module.ts'
import { AccessGuard } from './auth/access.guard.ts'
import { API_CONFIG, type ApiConfig, type CoreConfig } from './config.ts'
import { CoreModule } from './core/core.module.ts'
import { DashboardModule } from './dashboard/dashboard.module.ts'
import { HealthModule } from './health/health.module.ts'
import { LiveModule } from './live/live.module.ts'
import { MerchantsModule } from './merchants/merchants.module.ts'
import { PaymentsModule } from './payments/payments.module.ts'
import { PayoutsModule } from './payouts/payouts.module.ts'
import { SettlementApiModule } from './settlement/settlement-api.module.ts'
import { WebhooksApiModule } from './webhooks/webhooks-api.module.ts'

@Module({})
export class AppModule {
  static register(config: { core: CoreConfig; api: ApiConfig }): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.register(config.core, { provide: API_CONFIG, useValue: config.api }),
        HealthModule,
        PaymentsModule,
        MerchantsModule,
        PayoutsModule,
        AccountsModule,
        WebhooksApiModule,
        SettlementApiModule,
        AuditApiModule,
        LiveModule,
        DashboardModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: AccessGuard }],
    }
  }
}

export function configureApp(app: NestExpressApplication, config: ApiConfig): NestExpressApplication {
  app.set('trust proxy', config.trustProxy)
  app.useBodyParser('json', { limit: '16kb' })
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  app.enableShutdownHooks()
  return app
}
