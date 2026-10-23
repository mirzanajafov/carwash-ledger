import { Module } from '@nestjs/common'
import { LedgerModule } from '../ledger/ledger.module.ts'
import { PspModule } from '../psp/psp.module.ts'
import { SettlementIngestService } from './ingest.service.ts'
import { ReconciliationService } from './reconciliation.service.ts'

@Module({
  imports: [LedgerModule, PspModule],
  providers: [SettlementIngestService, ReconciliationService],
  exports: [SettlementIngestService, ReconciliationService],
})
export class SettlementModule {}
