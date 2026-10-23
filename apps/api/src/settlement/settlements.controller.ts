import { Controller, Param, Post, Query } from '@nestjs/common'
import type { SettlementView } from '@carwash/contracts'
import { AdminOnly } from '../auth/access.guard.ts'
import { CurrencyQuery, DayParams } from '../http/dto.ts'
import { Settlements } from './settlements.service.ts'

@AdminOnly()
@Controller('v1/settlements')
export class SettlementsController {
  readonly #settlements: Settlements

  constructor(settlements: Settlements) {
    this.#settlements = settlements
  }

  @Post(':day/ingest')
  async ingest(@Param() { day }: DayParams, @Query() { currency }: CurrencyQuery): Promise<SettlementView> {
    const outcome = await this.#settlements.ingest(day, currency)
    const reconciliation = outcome === 'not_ready' ? undefined : await this.#settlements.reconcile(currency)
    return { object: 'settlement', day, currency, outcome, reconciliation }
  }
}
