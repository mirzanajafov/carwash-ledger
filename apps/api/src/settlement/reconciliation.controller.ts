import { Controller, Get, Param, Query } from '@nestjs/common'
import type { BreakList, SettlementDayList, SettlementDayView } from '@carwash/contracts'
import { AdminOnly } from '../auth/access.guard.ts'
import { BreaksQuery, CurrencyQuery, DayParams, DaysQuery } from '../http/dto.ts'
import { Settlements } from './settlements.service.ts'

@AdminOnly()
@Controller('v1/reconciliation')
export class ReconciliationController {
  readonly #settlements: Settlements

  constructor(settlements: Settlements) {
    this.#settlements = settlements
  }

  @Get('days')
  async days(@Query() { currency, limit }: DaysQuery): Promise<SettlementDayList> {
    return { object: 'list', ...(await this.#settlements.days(currency, limit)) }
  }

  @Get('days/:day')
  async day(@Param() { day }: DayParams, @Query() { currency }: CurrencyQuery): Promise<SettlementDayView> {
    return this.#settlements.day(currency, day, 200)
  }

  @Get('breaks')
  async breaks(@Query() { currency, from, through }: BreaksQuery): Promise<BreakList> {
    return { object: 'list', data: await this.#settlements.breaks(currency, from, through ?? from) }
  }
}
