import { Controller, Param, Post, Query } from '@nestjs/common'
import type { SettlementView } from '@carwash/contracts'
import { AdminOnly } from '../auth/access.guard.ts'
import { CurrencyQuery, DayParams } from '../http/dto.ts'
import { SettlementIngestService } from './ingest.service.ts'
import { ReconciliationService } from './reconciliation.service.ts'

@AdminOnly()
@Controller('v1/settlements')
export class SettlementsController {
  readonly #ingest: SettlementIngestService
  readonly #reconciliation: ReconciliationService

  constructor(ingest: SettlementIngestService, reconciliation: ReconciliationService) {
    this.#ingest = ingest
    this.#reconciliation = reconciliation
  }

  @Post(':day/ingest')
  async ingest(@Param() { day }: DayParams, @Query() { currency }: CurrencyQuery): Promise<SettlementView> {
    const outcome = await this.#ingest.ingest(day, currency)
    const reconciliation = outcome === 'not_ready' ? undefined : await this.#reconciliation.reconcile(currency)
    return { object: 'settlement', day, currency, outcome, reconciliation }
  }
}
