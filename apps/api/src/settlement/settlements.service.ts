import { Inject, Injectable, Logger } from '@nestjs/common'
import { postInTransaction, type EntryInput } from '@carwash/ledger'
import { BREAK_CLASSES, reconcile, window, type BreakClass, type LedgerItem } from '@carwash/recon'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { journalEvents } from '../events/events.ts'
import { ApiError } from '../http/api-error.ts'
import { Chart } from '../ledger/chart.service.ts'
import { PspClient } from '../psp/psp.client.ts'
import { parseSettlementFile } from './settlement-file.ts'

export type IngestOutcome = 'ingested' | 'already' | 'not_ready'

export interface ReconcileSummary {
  currency: string
  from: number
  through: number
  lines: number
  items: number
  matched: number
  late: number
  pending: number
  breaks: Record<BreakClass, number>
}

const ITEMS = `
  SELECT j.external_ref AS "journalRef", a.id::text AS "attemptId", a.kind::text AS kind, e.amount::text AS gross,
         floor(extract(epoch FROM a.resolved_at) / $1)::int AS day,
         (extract(epoch FROM a.resolved_at) * 1000)::float8 AS "resolvedAt"
  FROM attempts a
  JOIN journals j ON j.external_ref = CASE WHEN a.kind = 'capture' THEN 'capture:' || a.payment_id ELSE 'refund:' || a.refund_id END
  JOIN entries e ON e.journal_id = j.id AND e.account_id = $2
  WHERE a.kind IN ('capture', 'refund') AND a.status = 'succeeded' AND a.currency = $3
    AND a.resolved_at >= to_timestamp($4::bigint * $1) AND a.resolved_at < to_timestamp(($5::bigint + 1) * $1)`

const LINES = `
  SELECT l.file_id AS "fileId", f.day::int AS day, l.line, l.operation, l.reference, l.kind, l.gross::text AS gross, l.fee::text AS fee, l.net::text AS net
  FROM settlement_lines l JOIN settlement_files f ON f.id = l.file_id
  WHERE f.currency = $1 AND f.day BETWEEN $2 AND $3
  ORDER BY f.day, l.line`

@Injectable()
export class Settlements {
  readonly #db: Database
  readonly #chart: Chart
  readonly #psp: PspClient
  readonly #config: ApiConfig
  readonly #logger = new Logger('settlements')

  constructor(db: Database, chart: Chart, psp: PspClient, @Inject(API_CONFIG) config: ApiConfig) {
    this.#db = db
    this.#chart = chart
    this.#psp = psp
    this.#config = config
  }

  async ingest(day: number, currency: string): Promise<IngestOutcome> {
    const accounts = this.#chart.accounts(currency)
    const reply = await this.#psp.settlementFile(day, currency)
    if (reply.kind === 'not_ready') return 'not_ready'
    if (reply.kind === 'unknown') throw new ApiError(503, 'psp_unavailable', `the PSP did not hand over day ${day} (${reply.reason})`, { 'Retry-After': '5' })
    const file = parseSettlementFile(reply.csv)
    if (file.day !== day || file.currency !== currency) throw new Error(`asked for ${currency} day ${day}, got ${file.currency} day ${file.day}`)
    return this.#db.transaction(async (client) => {
      const existing = await client.query('SELECT 1 FROM settlement_files WHERE id = $1', [file.id])
      if (existing.rowCount === 1) return 'already'
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
      await client.query('INSERT INTO settlement_files (id, day, currency, lines, gross, fee, net, journal_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        file.id,
        file.day,
        file.currency,
        file.lines.length,
        file.gross,
        file.fee,
        file.net,
        journalId,
      ])
      await client.query(
        `INSERT INTO settlement_lines (file_id, line, operation, reference, kind, gross, fee, net, operated_at)
         SELECT $1, * FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[], $8::bigint[], $9::timestamptz[])`,
        [
          file.id,
          file.lines.map((l) => l.line),
          file.lines.map((l) => l.operation),
          file.lines.map((l) => l.reference),
          file.lines.map((l) => l.kind),
          file.lines.map((l) => l.gross.toString()),
          file.lines.map((l) => l.fee.toString()),
          file.lines.map((l) => l.net.toString()),
          file.operatedAt,
        ],
      )
      return 'ingested'
    })
  }

  async reconcile(currency: string): Promise<ReconcileSummary | undefined> {
    const calendar = await this.#psp.calendar()
    if (calendar.kind === 'unknown')
      throw new ApiError(503, 'psp_unavailable', `the PSP's calendar is not available (${calendar.reason})`, { 'Retry-After': '5' })
    const { rows: latest } = await this.#db.pool.query<{ day: number | null }>('SELECT max(day)::int AS day FROM settlement_files WHERE currency = $1', [
      currency,
    ])
    const through = latest[0]!.day
    if (through === null) return undefined
    const span = window(through, this.#config.reconWindowDays)
    const receivable = this.#chart.accounts(currency).receivable.id
    const items = (
      await this.#db.pool.query<Omit<LedgerItem, 'gross'> & { gross: string }>(ITEMS, [
        calendar.daySeconds,
        receivable,
        currency,
        span.itemsFrom,
        span.itemsThrough,
      ])
    ).rows.map((row) => ({ ...row, gross: BigInt(row.gross) }))
    const lines = (
      await this.#db.pool.query<{
        fileId: string
        day: number
        line: number
        operation: string
        reference: string
        kind: 'capture' | 'refund'
        gross: string
        fee: string
        net: string
      }>(LINES, [currency, span.linesFrom, span.linesThrough])
    ).rows.map((row) => ({ ...row, gross: BigInt(row.gross), fee: BigInt(row.fee), net: BigInt(row.net) }))
    const result = reconcile(lines, items, {
      contract: { bps: BigInt(this.#config.pspFeeBps), fixed: this.#config.pspFeeFixed },
      fallback: this.#config.reconFallback,
      settledThrough: through,
    })
    const kept = result.breaks.filter((b) => b.day >= span.keepFrom && b.day <= span.keepThrough)
    await this.#db.transaction(async (client) => {
      await client.query('DELETE FROM recon_breaks WHERE currency = $1 AND day BETWEEN $2 AND $3', [currency, span.keepFrom, span.keepThrough])
      if (kept.length === 0) return
      await client.query(
        `INSERT INTO recon_breaks (currency, day, class, file_id, line, journal_ref, attempt_id, detail)
         SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::text[], $5::int[], $6::text[], $7::uuid[], $8::text[])`,
        [
          currency,
          kept.map((b) => b.day),
          kept.map((b) => b.class),
          kept.map((b) => b.line?.fileId ?? null),
          kept.map((b) => b.line?.line ?? null),
          kept.map((b) => b.item?.journalRef ?? null),
          kept.map((b) => b.item?.attemptId ?? null),
          kept.map((b) => b.detail),
        ],
      )
    })
    const breaks = Object.fromEntries(BREAK_CLASSES.map((c) => [c, kept.filter((b) => b.class === c).length])) as Record<BreakClass, number>
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

  async catchUp(): Promise<number> {
    const calendar = await this.#psp.calendar()
    if (calendar.kind === 'unknown') return 0
    let ingested = 0
    for (const currency of this.#config.currencies) {
      let day = await this.#firstOpenDay(currency, calendar.daySeconds, calendar.currentDay)
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
      if (fresh) await this.reconcile(currency)
    }
    if (ingested > 0) this.#logger.log(`ingested ${ingested} settlement files`)
    return ingested
  }

  async breaks(currency: string, from: number, through: number) {
    const { rows } = await this.#db.pool.query(
      `SELECT day::int AS day, class, file_id, line, journal_ref, attempt_id, detail
       FROM recon_breaks WHERE currency = $1 AND day BETWEEN $2 AND $3 ORDER BY day, class, id`,
      [currency, from, through],
    )
    return rows
  }

  async days(currency: string, limit: number) {
    const calendar = await this.#psp.calendar()
    const { rows } = await this.#db.pool.query<{
      day: number
      id: string
      lines: number
      gross: string
      fee: string
      net: string
      journal_id: string | null
      received_at: Date
      breaks: Record<string, number> | null
    }>(
      `SELECT f.day::int AS day, f.id, f.lines, f.gross::text, f.fee::text, f.net::text, f.journal_id::text, f.received_at,
              (SELECT jsonb_object_agg(class, n) FROM (SELECT class, count(*)::int AS n FROM recon_breaks b WHERE b.currency = f.currency AND b.day = f.day GROUP BY class) c) AS breaks
       FROM settlement_files f WHERE f.currency = $1 ORDER BY f.day DESC LIMIT $2`,
      [currency, limit],
    )
    return {
      day_seconds: calendar.kind === 'answer' ? calendar.daySeconds : null,
      current_day: calendar.kind === 'answer' ? calendar.currentDay : null,
      data: rows.map((row) => ({ ...row, received_at: row.received_at.toISOString(), breaks: row.breaks ?? {} })),
    }
  }

  async day(currency: string, day: number, limit: number) {
    const { rows: files } = await this.#db.pool.query<{
      id: string
      lines: number
      gross: string
      fee: string
      net: string
      journal_id: string | null
      received_at: Date
    }>(`SELECT id, lines, gross::text, fee::text, net::text, journal_id::text, received_at FROM settlement_files WHERE currency = $1 AND day = $2`, [
      currency,
      day,
    ])
    const file = files[0]
    const { rows: lines } = file
      ? await this.#db.pool.query(
          `SELECT l.line, l.operation, l.reference, l.kind, l.gross::text, l.fee::text, l.net::text, l.operated_at,
                  (SELECT b.class FROM recon_breaks b WHERE b.file_id = l.file_id AND b.line = l.line ORDER BY b.id LIMIT 1) AS break
           FROM settlement_lines l WHERE l.file_id = $1 ORDER BY (SELECT 1 FROM recon_breaks b WHERE b.file_id = l.file_id AND b.line = l.line LIMIT 1) NULLS LAST, l.line LIMIT $2`,
          [file.id, limit],
        )
      : { rows: [] }
    return {
      object: 'settlement_day',
      day,
      currency,
      file: file ? { ...file, received_at: file.received_at.toISOString() } : null,
      lines,
      breaks: await this.breaks(currency, day, day),
    }
  }

  async #firstOpenDay(currency: string, daySeconds: number, currentDay: number): Promise<number> {
    const { rows } = await this.#db.pool.query<{ latest: number | null; first: number | null }>(
      `SELECT (SELECT max(day)::int FROM settlement_files WHERE currency = $1) AS latest,
              (SELECT floor(extract(epoch FROM min(resolved_at)) / $2)::int FROM attempts
               WHERE currency = $1 AND kind IN ('capture', 'refund') AND status = 'succeeded') AS first`,
      [currency, daySeconds],
    )
    const { latest, first } = rows[0]!
    if (latest !== null) return latest + 1
    return first ?? currentDay
  }
}
