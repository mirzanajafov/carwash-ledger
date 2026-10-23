import { Module, type DynamicModule } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.ts'
import { SequencerService } from '../audit/sequencer.service.ts'
import { VerificationJob } from '../audit/verification-job.ts'
import { WORKER_CONFIG, type CoreConfig, type WorkerConfig } from '../config.ts'
import { EventConsumersService } from '../consumers/event-consumers.service.ts'
import { CoreModule } from '../core/core.module.ts'
import { HealthModule } from '../health/health.module.ts'
import { IdempotencyModule } from '../idempotency/idempotency.module.ts'
import { AttemptsModule } from '../payments/attempts.module.ts'
import { PspModule } from '../psp/psp.module.ts'
import { SettlementModule } from '../settlement/settlement.module.ts'
import { WebhooksModule } from '../webhooks/webhooks.module.ts'
import { OutboxRelayService } from './outbox-relay.service.ts'
import { RecoveryService } from './recovery.service.ts'
import { SchedulerService } from './scheduler.service.ts'

@Module({})
export class WorkerModule {
  static register(config: { core: CoreConfig; worker: WorkerConfig }): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        CoreModule.register(config.core, { provide: WORKER_CONFIG, useValue: config.worker }),
        HealthModule,
        AttemptsModule,
        AuditModule,
        IdempotencyModule,
        PspModule,
        SettlementModule,
        WebhooksModule,
      ],
      providers: [OutboxRelayService, EventConsumersService, SequencerService, RecoveryService, SchedulerService, VerificationJob],
    }
  }
}
