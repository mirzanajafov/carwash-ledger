import { Controller, Param, Post, Query } from '@nestjs/common'
import { AdminOnly } from '../auth/access.guard.ts'
import { currencyCode, dayNumber } from './params.ts'
import { Settlements } from './settlements.service.ts'

@AdminOnly()
@Controller('v1/settlements')
export class SettlementsController {
  readonly #settlements: Settlements

  constructor(settlements: Settlements) {
    this.#settlements = settlements
  }

  @Post(':day/ingest')
  async ingest(@Param('day') day: string, @Query('currency') currency?: string) {
    const code = currencyCode(currency)
    const number = dayNumber(day, 'day')
    const outcome = await this.#settlements.ingest(number, code)
    const reconciliation = outcome === 'not_ready' ? undefined : await this.#settlements.reconcile(code)
    return { object: 'settlement', day: number, currency: code, outcome, reconciliation }
  }
}
