import { Module } from '@nestjs/common'
import { LedgerModule } from '../ledger/ledger.module.ts'
import { PspModule } from '../psp/psp.module.ts'
import { Settlements } from './settlements.service.ts'

@Module({ imports: [LedgerModule, PspModule], providers: [Settlements], exports: [Settlements] })
export class SettlementModule {}
