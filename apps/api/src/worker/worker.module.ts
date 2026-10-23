import { Module, type DynamicModule } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.ts'
import { Sequencer } from '../audit/sequencer.service.ts'
import { VerificationJob } from '../audit/verification-job.ts'
import type { ApiConfig } from '../config.ts'
import { EventConsumers } from '../consumers/event-consumers.service.ts'
import { CoreModule } from '../core/core.module.ts'
import { HealthModule } from '../health/health.module.ts'
import { IdempotencyModule } from '../idempotency/idempotency.module.ts'
import { AttemptsModule } from '../payments/attempts.module.ts'
import { PspModule } from '../psp/psp.module.ts'
import { SettlementModule } from '../settlement/settlement.module.ts'
import { WebhooksModule } from '../webhooks/webhooks.module.ts'
import { OutboxRelay } from './outbox-relay.service.ts'
import { Recovery } from './recovery.service.ts'
import { Scheduler } from './scheduler.service.ts'

@Module({})
export class WorkerModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [CoreModule.register(config), HealthModule, AttemptsModule, AuditModule, IdempotencyModule, PspModule, SettlementModule, WebhooksModule],
      providers: [OutboxRelay, EventConsumers, Sequencer, Recovery, Scheduler, VerificationJob],
    }
  }
}
