import { Inject, Injectable } from '@nestjs/common'
import type { BreakClass, SettlementView } from '@carwash/contracts'
import { reconcile, window } from '@carwash/recon'
import { CORE_CONFIG, type CoreConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { ChartService } from '../ledger/chart.service.ts'
import { PspClient, type CalendarReply } from '../psp/psp.client.ts'
import { PspUnavailableError } from '../psp/psp.errors.ts'
import { latestFileDay, ledgerItems, linesForMatching, recentFiles, replaceBreaks, type FileSummaryRow } from './settlements.repository.ts'

export type ReconcileSummary = NonNullable<SettlementView['reconciliation']>

@Injectable()
export class ReconciliationService {
  readonly #db: Database
  readonly #chart: ChartService
  readonly #psp: PspClient
  readonly #config: CoreConfig

  constructor(db: Database, chart: ChartService, psp: PspClient, @Inject(CORE_CONFIG) config: CoreConfig) {
    this.#db = db
    this.#chart = chart
    this.#psp = psp
    this.#config = config
  }

  async reconcile(currency: string): Promise<ReconcileSummary | undefined> {
    const calendar = await this.#psp.calendar()
    if (calendar.kind === 'unknown') throw new PspUnavailableError(`the PSP's calendar is not available (${calendar.reason})`, 5)
    const through = await latestFileDay(this.#db.pool, currency)
    if (through === null) return undefined
    const span = window(through, this.#config.reconWindowDays)
    const items = await ledgerItems(this.#db.pool, {
      daySeconds: calendar.daySeconds,
      receivableId: this.#chart.accounts(currency).receivable.id,
      currency,
      from: span.itemsFrom,
      through: span.itemsThrough,
    })
    const lines = await linesForMatching(this.#db.pool, currency, span.linesFrom, span.linesThrough)
    const result = reconcile(lines, items, { contract: this.#config.pspFees, fallback: this.#config.reconFallback, settledThrough: through })
    const kept = result.breaks.filter((b) => b.day >= span.keepFrom && b.day <= span.keepThrough)
    await this.#db.transaction((client) => replaceBreaks(client, currency, span.keepFrom, span.keepThrough, kept))
    const breaks: Record<BreakClass, number> = { missing_line: 0, duplicate_line: 0, wrong_amount: 0, fee_difference: 0, unknown_line: 0 }
    for (const b of kept) breaks[b.class]++
    return {
      currency,
      from: span.keepFrom,
      through,
      lines: lines.length,
      items: items.length,
      matched: result.matches.length,
      late: result.matches.filter((m) => m.late).length,
      pending: result.pending.length,
      breaks,
    }
  }

  async recentDays(currency: string, limit: number): Promise<{ calendar: CalendarReply; files: FileSummaryRow[] }> {
    const [calendar, files] = await Promise.all([this.#psp.calendar(), recentFiles(this.#db.pool, currency, limit)])
    return { calendar, files }
  }
}
