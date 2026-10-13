import { Controller, Get, Param, Post, Query } from '@nestjs/common'
import { AdminOnly } from '../auth/access.guard.ts'
import { badRequest } from '../http/api-error.ts'
import { Settlements } from './settlements.service.ts'

function dayNumber(value: string | undefined, name: string): number {
  if (value === undefined || !/^\d{1,12}$/.test(value)) throw badRequest(`${name} must be a day number`)
  return Number(value)
}

function currencyCode(value: string | undefined): string {
  const currency = value ?? 'EUR'
  if (!/^[A-Z]{3}$/.test(currency)) throw badRequest('currency must be a three-letter code')
  return currency
}

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
    const outcome = await this.#settlements.ingest(dayNumber(day, 'day'), code)
    const reconciliation = outcome === 'not_ready' ? undefined : await this.#settlements.reconcile(code)
    return { object: 'settlement', day: Number(day), currency: code, outcome, reconciliation }
  }
}

@AdminOnly()
@Controller('v1/reconciliation')
export class ReconciliationController {
  readonly #settlements: Settlements

  constructor(settlements: Settlements) {
    this.#settlements = settlements
  }

  @Get('breaks')
  async breaks(@Query('from') from?: string, @Query('through') through?: string, @Query('currency') currency?: string) {
    const first = dayNumber(from, 'from')
    const last = through === undefined ? first : dayNumber(through, 'through')
    return { object: 'list', data: await this.#settlements.breaks(currencyCode(currency), first, last) }
  }
}
