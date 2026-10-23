import { Inject, Injectable, Logger } from '@nestjs/common'
import type { SettlementView } from '@carwash/contracts'
import { postInTransaction, type EntryInput } from '@carwash/ledger'
import { CORE_CONFIG, type CoreConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { journalEvents } from '../events/events.ts'
import { ChartService } from '../ledger/chart.service.ts'
import { PspClient } from '../psp/psp.client.ts'
import { PspUnavailableError } from '../psp/psp.errors.ts'
import { ReconciliationService } from './reconciliation.service.ts'
import { parseSettlementFile } from './settlement-file.ts'
import { fileExists, insertFile, settledSoFar } from './settlements.repository.ts'

export type IngestOutcome = SettlementView['outcome']

@Injectable()
export class SettlementIngestService {
  readonly #db: Database
  readonly #chart: ChartService
  readonly #psp: PspClient
  readonly #reconciliation: ReconciliationService
  readonly #config: CoreConfig
  readonly #logger = new Logger('settlements')

  constructor(db: Database, chart: ChartService, psp: PspClient, reconciliation: ReconciliationService, @Inject(CORE_CONFIG) config: CoreConfig) {
    this.#db = db
    this.#chart = chart
    this.#psp = psp
    this.#reconciliation = reconciliation
    this.#config = config
  }

  async ingest(day: number, currency: string): Promise<IngestOutcome> {
    const accounts = this.#chart.accounts(currency)
    const reply = await this.#psp.settlementFile(day, currency)
    if (reply.kind === 'not_ready') return 'not_ready'
    if (reply.kind === 'unknown') throw new PspUnavailableError(`the PSP did not hand over day ${day} (${reply.reason})`, 5)
    const file = parseSettlementFile(reply.csv)
    if (file.day !== day || file.currency !== currency) throw new Error(`asked for ${currency} day ${day}, got ${file.currency} day ${file.day}`)
    return this.#db.transaction(async (client) => {
      if (await fileExists(client, file.id)) return 'already'
      const entries: EntryInput[] = [
        { accountId: accounts.bank.id, amount: file.net },
        { accountId: accounts.pspFees.id, amount: file.fee },
        { accountId: accounts.receivable.id, amount: -file.gross },
      ].filter((entry) => entry.amount !== 0n)
      let journalId: bigint | null = null
      if (entries.length > 0) {
        journalId = await postInTransaction(client, this.#chart.registry, { externalRef: `settlement:${file.id}`, entries })
        await journalEvents(client, journalId)
      }
      await insertFile(client, file, journalId)
      return 'ingested'
    })
  }

  async catchUp(): Promise<number> {
    const calendar = await this.#psp.calendar()
    if (calendar.kind === 'unknown') return 0
    let ingested = 0
    for (const currency of this.#config.currencies) {
      const { latest, first } = await settledSoFar(this.#db.pool, currency, calendar.daySeconds)
      let day = latest === null ? (first ?? calendar.currentDay) : latest + 1
      let fresh = false
      while (day < calendar.currentDay) {
        const outcome = await this.ingest(day, currency)
        if (outcome === 'not_ready') break
        if (outcome === 'ingested') {
          ingested++
          fresh = true
        }
        day++
      }
      if (fresh) await this.#reconciliation.reconcile(currency)
    }
    if (ingested > 0) this.#logger.log(`ingested ${ingested} settlement files`)
    return ingested
  }
}
