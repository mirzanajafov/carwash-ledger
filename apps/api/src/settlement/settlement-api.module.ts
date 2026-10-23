import { Module } from '@nestjs/common'
import { ReconciliationController } from './reconciliation.controller.ts'
import { SettlementModule } from './settlement.module.ts'
import { SettlementsController } from './settlements.controller.ts'

@Module({ imports: [SettlementModule], controllers: [SettlementsController, ReconciliationController] })
export class SettlementApiModule {}
