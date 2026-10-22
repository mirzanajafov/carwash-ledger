import { createHash } from 'node:crypto'
import { firstRow, type Transaction, withTransaction } from '@carwash/pg'
import type pg from 'pg'
import type { Faults, SettlementFault } from './faults.ts'

export interface SettlementSettings {
  daySeconds: number
  feeBps: number
  feeFixed: number
}

export interface SettleableOperation {
  id: string
  key: string
  kind: 'capture' | 'refund'
  amount: number
  operatedAt: Date
  day: number
}

export interface PlannedLine {
  operationId: string
  shownOperation: string
  reference: string
  kind: 'capture' | 'refund'
  gross: number
  fee: number
  net: number
  operatedAt: Date
  faults: SettlementFault[]
  listed: boolean
}

export interface SettlementFile {
  id: string
  day: number
  currency: string
  lines: number
  gross: number
  fee: number
  net: number
  csv: string
}

export function pspFee(kind: 'capture' | 'refund', amount: number, settings: Pick<SettlementSettings, 'feeBps' | 'feeFixed'>): number {
  if (kind === 'refund') return 0
  return Math.floor((amount * settings.feeBps + 5000) / 10_000) + settings.feeFixed
}

export function belongsTo(day: number, operation: SettleableOperation, nextDay: boolean, settledDays: ReadonlySet<number>): boolean {
  if (operation.day === day) return !nextDay
  if (operation.day === day - 1 && nextDay) return true
  return operation.day < day && settledDays.has(operation.day)
}

export function planLines(
  operations: readonly SettleableOperation[],
  day: number,
  settledDays: ReadonlySet<number>,
  faults: Faults,
  settings: SettlementSettings,
): PlannedLine[] {
  const lines: PlannedLine[] = []
  for (const operation of operations) {
    const drawn = faults.settlement(operation.id)
    if (!belongsTo(day, operation, drawn.faults.has('nextDay'), settledDays)) continue
    const applied = new Set(drawn.faults)
    if (operation.day !== day) applied.delete('nextDay')
    const sign = operation.kind === 'capture' ? 1 : -1
    const amount = applied.has('wrongAmount') ? operation.amount - 1 : operation.amount
    const fee = pspFee(operation.kind, operation.amount, settings) + (applied.has('feeDifference') ? 1 + Math.floor(drawn.draw('feeDifference.cents') * 5) : 0)
    const dropped = applied.has('droppedReference')
    const line: PlannedLine = {
      operationId: operation.id,
      shownOperation: dropped ? `stl_${createHash('sha256').update(`${operation.id}:${day}`).digest('hex').slice(0, 24)}` : operation.id,
      reference: dropped ? '' : operation.key,
      kind: operation.kind,
      gross: sign * amount,
      fee,
      net: sign * amount - fee,
      operatedAt: operation.operatedAt,
      faults: [...applied],
      listed: !applied.has('missingLine'),
    }
    lines.push(line)
    if (applied.has('duplicateLine') && line.listed) lines.push({ ...line })
  }
  return lines
}

export function renderCsv(file: Omit<SettlementFile, 'csv'>, lines: readonly PlannedLine[]): string {
  const rows = [
    'file,day,currency,lines,gross,fee,net',
    [file.id, file.day, file.currency, file.lines, file.gross, file.fee, file.net].join(','),
    'line,operation,reference,kind,gross,fee,net,operated_at',
    ...lines
      .filter((line) => line.listed)
      .map((line, i) => [i + 1, line.shownOperation, line.reference, line.kind, line.gross, line.fee, line.net, line.operatedAt.toISOString()].join(',')),
  ]
  return `${rows.join('\n')}\n`
}

interface LineRow {
  operation_id: string
  shown_operation: string
  reference: string
  kind: 'capture' | 'refund'
  gross: string
  fee: string
  net: string
  operated_at: Date
  faults: SettlementFault[]
  line: number | null
}

export class Settlements {
  readonly #pool: pg.Pool
  readonly #faults: Faults
  readonly #settings: SettlementSettings

  constructor(pool: pg.Pool, faults: Faults, settings: SettlementSettings) {
    this.#pool = pool
    this.#faults = faults
    this.#settings = settings
  }

  calendar(): { day_seconds: number; current_day: number } {
    return { day_seconds: this.#settings.daySeconds, current_day: this.dayOf(new Date()) }
  }

  dayOf(time: Date): number {
    return Math.floor(time.getTime() / 1000 / this.#settings.daySeconds)
  }

  async close(day: number): Promise<void> {
    await this.#pool.query('INSERT INTO settlement_closures (day) VALUES ($1) ON CONFLICT DO NOTHING', [day])
  }

  file(day: number, currency: string): Promise<SettlementFile | undefined> {
    return withTransaction(this.#pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`settlement:${currency}`])
      return (await this.#stored(client, day, currency)) ?? (await this.#generate(client, day, currency))
    })
  }

  async #stored(client: Transaction, day: number, currency: string): Promise<SettlementFile | undefined> {
    const { rows } = await client.query<{ id: string; lines: number; gross: string; fee: string; net: string }>(
      'SELECT id, lines, gross::text, fee::text, net::text FROM settlement_files WHERE day = $1 AND currency = $2',
      [day, currency],
    )
    const stored = rows[0]
    if (!stored) return undefined
    const lines = (
      await client.query<LineRow>(
        `SELECT operation_id, shown_operation, reference, kind, gross::text, fee::text, net::text, operated_at, faults, line
         FROM settlement_lines WHERE file_id = $1 ORDER BY line NULLS LAST, id`,
        [stored.id],
      )
    ).rows.map((row) => ({
      operationId: row.operation_id,
      shownOperation: row.shown_operation,
      reference: row.reference,
      kind: row.kind,
      gross: Number(row.gross),
      fee: Number(row.fee),
      net: Number(row.net),
      operatedAt: row.operated_at,
      faults: row.faults,
      listed: row.line !== null,
    }))
    const head = { id: stored.id, day, currency, lines: stored.lines, gross: Number(stored.gross), fee: Number(stored.fee), net: Number(stored.net) }
    return { ...head, csv: renderCsv(head, lines) }
  }

  async #generate(client: Transaction, day: number, currency: string): Promise<SettlementFile | undefined> {
    const clock = firstRow(
      await client.query<{ now: Date; closed: boolean }>('SELECT now(), EXISTS (SELECT 1 FROM settlement_closures WHERE day = $1) AS closed', [day]),
    )
    const ended = clock.now.getTime() / 1000 >= (day + 1) * this.#settings.daySeconds
    if (!ended && !clock.closed) return undefined
    const settled = new Set(
      (await client.query<{ day: string }>('SELECT day::text FROM settlement_files WHERE currency = $1', [currency])).rows.map((row) => Number(row.day)),
    )
    const { rows } = await client.query<{ id: string; key: string; kind: 'capture' | 'refund'; amount: string; created_at: Date }>(
      `SELECT o.id, o.idempotency_key AS key, o.kind, o.amount::text, o.created_at
       FROM operations o
       WHERE o.status = 'succeeded' AND o.kind IN ('capture', 'refund') AND o.currency = $1
         AND o.created_at < to_timestamp(($2::bigint + 1) * $3::bigint)
         AND NOT EXISTS (SELECT 1 FROM settlement_lines l WHERE l.operation_id = o.id)
       ORDER BY o.created_at, o.id`,
      [currency, day, this.#settings.daySeconds],
    )
    const operations = rows.map((row) => ({
      id: row.id,
      key: row.key,
      kind: row.kind,
      amount: Number(row.amount),
      operatedAt: row.created_at,
      day: this.dayOf(row.created_at),
    }))
    const lines = planLines(operations, day, settled, this.#faults, this.#settings)
    const listed = lines.filter((line) => line.listed)
    const head = {
      id: `stl_${currency}_${day}`,
      day,
      currency,
      lines: listed.length,
      gross: listed.reduce((sum, line) => sum + line.gross, 0),
      fee: listed.reduce((sum, line) => sum + line.fee, 0),
      net: listed.reduce((sum, line) => sum + line.net, 0),
    }
    await client.query('INSERT INTO settlement_files (id, day, currency, lines, gross, fee, net) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      head.id,
      day,
      currency,
      head.lines,
      head.gross,
      head.fee,
      head.net,
    ])
    let number = 0
    for (const line of lines) {
      await client.query(
        `INSERT INTO settlement_lines (file_id, line, operation_id, shown_operation, reference, kind, gross, fee, net, operated_at, faults)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          head.id,
          line.listed ? ++number : null,
          line.operationId,
          line.shownOperation,
          line.reference,
          line.kind,
          line.gross,
          line.fee,
          line.net,
          line.operatedAt,
          line.faults,
        ],
      )
    }
    return { ...head, csv: renderCsv(head, lines) }
  }
}
