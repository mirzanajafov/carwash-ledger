import { Module } from '@nestjs/common'
import { IdempotencyModule } from '../idempotency/idempotency.module.ts'
import { LedgerModule } from '../ledger/ledger.module.ts'
import { MerchantsController } from './merchants.controller.ts'
import { MerchantsService } from './merchants.service.ts'

@Module({ imports: [IdempotencyModule, LedgerModule], controllers: [MerchantsController], providers: [MerchantsService] })
export class MerchantsModule {}
