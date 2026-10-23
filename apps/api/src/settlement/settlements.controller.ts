import { Controller, Param, Post, Query } from '@nestjs/common'
import type { SettlementView } from '@carwash/contracts'
import { AdminOnly } from '../auth/access.guard.ts'
import { CurrencyQuery, DayParams } from '../http/dto.ts'
import { SettlementIngestService } from './settlement-ingest.service.ts'

@AdminOnly()
@Controller('v1/settlements')
export class SettlementsController {
  readonly #ingest: SettlementIngestService

  constructor(ingest: SettlementIngestService) {
    this.#ingest = ingest
  }

  @Post(':day/ingest')
  async ingest(@Param() { day }: DayParams, @Query() { currency }: CurrencyQuery): Promise<SettlementView> {
    return { object: 'settlement', day, currency, ...(await this.#ingest.ingestAndReconcile(day, currency)) }
  }
}
