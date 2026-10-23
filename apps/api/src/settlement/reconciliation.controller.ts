import { Controller, Get, Param, Query } from '@nestjs/common'
import type { BreakList, SettlementDayList, SettlementDayView } from '@carwash/contracts'
import { AdminOnly } from '../auth/access.guard.ts'
import { Database } from '../db/database.ts'
import { BreaksQuery, CurrencyQuery, DayParams, DaysQuery } from '../http/dto.ts'
import { PspClient } from '../psp/psp.client.ts'
import { dayListView, dayView } from './settlement.views.ts'
import { breaksIn, fileOfDay, linesOfFile, recentFiles } from './settlements.repository.ts'

@AdminOnly()
@Controller('v1/reconciliation')
export class ReconciliationController {
  readonly #db: Database
  readonly #psp: PspClient

  constructor(db: Database, psp: PspClient) {
    this.#db = db
    this.#psp = psp
  }

  @Get('days')
  async days(@Query() { currency, limit }: DaysQuery): Promise<SettlementDayList> {
    return dayListView(await this.#psp.calendar(), await recentFiles(this.#db.pool, currency, limit))
  }

  @Get('days/:day')
  async day(@Param() { day }: DayParams, @Query() { currency }: CurrencyQuery): Promise<SettlementDayView> {
    const file = await fileOfDay(this.#db.pool, currency, day)
    const lines = file ? await linesOfFile(this.#db.pool, file.id, 200) : []
    return dayView(currency, day, file, lines, await breaksIn(this.#db.pool, currency, day, day))
  }

  @Get('breaks')
  async breaks(@Query() { currency, from, through }: BreaksQuery): Promise<BreakList> {
    return { object: 'list', data: await breaksIn(this.#db.pool, currency, from, through ?? from) }
  }
}
