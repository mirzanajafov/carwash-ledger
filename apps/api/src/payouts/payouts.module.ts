import { Module } from '@nestjs/common'
import { IdempotencyModule } from '../idempotency/idempotency.module.ts'
import { LedgerModule } from '../ledger/ledger.module.ts'
import { AttemptsModule } from '../payments/attempts.module.ts'
import { PayoutsController } from './payouts.controller.ts'
import { PayoutsService } from './payouts.service.ts'

@Module({ imports: [AttemptsModule, IdempotencyModule, LedgerModule], controllers: [PayoutsController], providers: [PayoutsService] })
export class PayoutsModule {}
