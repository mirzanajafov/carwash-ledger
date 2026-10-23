import { Controller, Get, Param, Query } from '@nestjs/common'
import type { BreakList, SettlementDayList, SettlementDayView } from '@carwash/contracts'
import { AdminOnly } from '../auth/access.guard.ts'
import { Database } from '../db/database.ts'
import { BreaksQuery, CurrencyQuery, DayParams, DaysQuery } from '../http/dto.ts'
import { ReconciliationService } from './reconciliation.service.ts'
import { breaksIn, findFileOfDay, linesOfFile } from './settlements.repository.ts'
import { dayListView, dayView } from './settlements.views.ts'

@AdminOnly()
@Controller('v1/reconciliation')
export class ReconciliationController {
  readonly #db: Database
  readonly #reconciliation: ReconciliationService

  constructor(db: Database, reconciliation: ReconciliationService) {
    this.#db = db
    this.#reconciliation = reconciliation
  }

  @Get('days')
  async days(@Query() { currency, limit }: DaysQuery): Promise<SettlementDayList> {
    const { calendar, files } = await this.#reconciliation.recentDays(currency, limit)
    return dayListView(calendar, files)
  }

  @Get('days/:day')
  async day(@Param() { day }: DayParams, @Query() { currency }: CurrencyQuery): Promise<SettlementDayView> {
    const [file, breaks] = await Promise.all([findFileOfDay(this.#db.pool, currency, day), breaksIn(this.#db.pool, currency, day, day)])
    const lines = file ? await linesOfFile(this.#db.pool, file.id, 200) : []
    return dayView(currency, day, file, lines, breaks)
  }

  @Get('breaks')
  async breaks(@Query() { currency, from, through }: BreaksQuery): Promise<BreakList> {
    return { object: 'list', data: await breaksIn(this.#db.pool, currency, from, through ?? from) }
  }
}
