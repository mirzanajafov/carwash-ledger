import { Module } from '@nestjs/common'
import { PspModule } from '../psp/psp.module.ts'
import { ReconciliationController } from './reconciliation.controller.ts'
import { SettlementModule } from './settlement.module.ts'
import { SettlementsController } from './settlements.controller.ts'

@Module({ imports: [SettlementModule, PspModule], controllers: [SettlementsController, ReconciliationController] })
export class SettlementApiModule {}
