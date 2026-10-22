import { Module } from '@nestjs/common'
import { IdempotencyModule } from '../idempotency/idempotency.module.ts'
import { LedgerModule } from '../ledger/ledger.module.ts'
import { PspModule } from '../psp/psp.module.ts'
import { AnomaliesController } from './anomalies.controller.ts'
import { AnomaliesService } from './anomalies.service.ts'
import { AttemptsModule } from './attempts.module.ts'
import { PaymentsController } from './payments.controller.ts'
import { PaymentsService } from './payments.service.ts'

@Module({
  imports: [AttemptsModule, IdempotencyModule, LedgerModule, PspModule],
  controllers: [PaymentsController, AnomaliesController],
  providers: [PaymentsService, AnomaliesService],
})
export class PaymentsModule {}
