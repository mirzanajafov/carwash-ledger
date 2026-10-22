import { Controller, Get, Param, Query } from '@nestjs/common'
import { AdminOnly } from '../auth/access.guard.ts'
import { badRequest } from '../http/api-error.ts'
import { currencyCode, dayNumber } from './params.ts'
import { Settlements } from './settlements.service.ts'

@AdminOnly()
@Controller('v1/reconciliation')
export class ReconciliationController {
  readonly #settlements: Settlements

  constructor(settlements: Settlements) {
    this.#settlements = settlements
  }

  @Get('days')
  async days(@Query('currency') currency?: string, @Query('limit') limit?: string) {
    const count = limit === undefined ? 7 : Number(limit)
    if (!Number.isInteger(count) || count < 1 || count > 60) throw badRequest('limit must be between 1 and 60')
    return { object: 'list', ...(await this.#settlements.days(currencyCode(currency), count)) }
  }

  @Get('days/:day')
  async day(@Param('day') day: string, @Query('currency') currency?: string) {
    return this.#settlements.day(currencyCode(currency), dayNumber(day, 'day'), 200)
  }

  @Get('breaks')
  async breaks(@Query('from') from?: string, @Query('through') through?: string, @Query('currency') currency?: string) {
    const first = dayNumber(from, 'from')
    const last = through === undefined ? first : dayNumber(through, 'through')
    return { object: 'list', data: await this.#settlements.breaks(currencyCode(currency), first, last) }
  }
}
