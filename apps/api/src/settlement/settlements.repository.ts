import type { BreakClass, BreakView } from '@carwash/contracts'
import { firstRow, type Queryable, type Transaction } from '@carwash/pg'
import type { Break, FileLine, Kind, LedgerItem } from '@carwash/recon'
import type { ParsedFile } from './settlement-file.ts'

export interface LedgerItemsQuery {
  daySeconds: number
  receivableId: bigint
  currency: string
  from: number
  through: number
}

export interface FileRow {
  id: string
  lines: number
  gross: string
  fee: string
  net: string
  journal_id: string | null
  received_at: Date
}

export interface FileSummaryRow extends FileRow {
  day: number
  breaks: Partial<Record<BreakClass, number>> | null
}

export interface LineRow {
  line: number
  operation: string
  reference: string
  kind: Kind
  gross: string
  fee: string
  net: string
  operated_at: Date
  break: BreakClass | null
}

const LEDGER_ITEMS = `
  SELECT j.external_ref AS "journalRef", a.id::text AS "attemptId", a.kind::text AS kind, e.amount::text AS gross,
         floor(extract(epoch FROM a.resolved_at) / $1)::int AS day,
         (extract(epoch FROM a.resolved_at) * 1000)::float8 AS "resolvedAt"
  FROM attempts a
  JOIN journals j ON j.external_ref = CASE WHEN a.kind = 'capture' THEN 'capture:' || a.payment_id ELSE 'refund:' || a.refund_id END
  JOIN entries e ON e.journal_id = j.id AND e.account_id = $2
  WHERE a.kind IN ('capture', 'refund') AND a.status = 'succeeded' AND a.currency = $3
    AND a.resolved_at >= to_timestamp($4::bigint * $1) AND a.resolved_at < to_timestamp(($5::bigint + 1) * $1)`

const LINES_FOR_MATCHING = `
  SELECT l.file_id AS "fileId", f.day::int AS day, l.line, l.operation, l.reference, l.kind, l.gross::text AS gross, l.fee::text AS fee, l.net::text AS net
  FROM settlement_lines l JOIN settlement_files f ON f.id = l.file_id
  WHERE f.currency = $1 AND f.day BETWEEN $2 AND $3
  ORDER BY f.day, l.line`

export function settlementsKey(currency: string): string {
  return `settlements:${currency}`
}

export async function fileExists(client: Transaction, id: string): Promise<boolean> {
  return (await client.query('SELECT 1 FROM settlement_files WHERE id = $1', [id])).rowCount === 1
}

export async function insertFile(client: Transaction, file: ParsedFile, journalId: bigint | null): Promise<void> {
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
}

export interface FilesSoFar {
  count: number
  latest: number | null
  readAt: string
}

export async function filesSoFar(db: Queryable, currency: string): Promise<FilesSoFar> {
  return firstRow(
    await db.query<FilesSoFar>(
      'SELECT count(*)::int AS count, max(day)::int AS latest, clock_timestamp()::text AS "readAt" FROM settlement_files WHERE currency = $1',
      [currency],
    ),
  )
}

export async function recordReconciliation(client: Transaction, currency: string, files: FilesSoFar): Promise<boolean> {
  const recorded = await client.query(
    `INSERT INTO reconciliations (currency, files, read_at) VALUES ($1, $2, $3)
     ON CONFLICT (currency) DO UPDATE SET files = excluded.files, read_at = excluded.read_at
     WHERE reconciliations.read_at < excluded.read_at`,
    [currency, files.count, files.readAt],
  )
  return recorded.rowCount === 1
}

export async function reconciliationDue(db: Queryable, currency: string): Promise<boolean> {
  return firstRow(
    await db.query<{ due: boolean }>(
      `SELECT (SELECT count(*) FROM settlement_files WHERE currency = $1) > coalesce((SELECT files FROM reconciliations WHERE currency = $1), 0) AS due`,
      [currency],
    ),
  ).due
}

export async function settledSoFar(db: Queryable, currency: string, daySeconds: number): Promise<{ latest: number | null; first: number | null }> {
  return firstRow(
    await db.query<{ latest: number | null; first: number | null }>(
      `SELECT (SELECT max(day)::int FROM settlement_files WHERE currency = $1) AS latest,
              (SELECT floor(extract(epoch FROM min(resolved_at)) / $2)::int FROM attempts
               WHERE currency = $1 AND kind IN ('capture', 'refund') AND status = 'succeeded') AS first`,
      [currency, daySeconds],
    ),
  )
}

export async function ledgerItems(db: Queryable, query: LedgerItemsQuery): Promise<LedgerItem[]> {
  const { rows } = await db.query<Omit<LedgerItem, 'gross'> & { gross: string }>(LEDGER_ITEMS, [
    query.daySeconds,
    query.receivableId,
    query.currency,
    query.from,
    query.through,
  ])
  return rows.map((row) => ({ ...row, gross: BigInt(row.gross) }))
}

export async function linesForMatching(db: Queryable, currency: string, from: number, through: number): Promise<FileLine[]> {
  const { rows } = await db.query<Omit<FileLine, 'gross' | 'fee' | 'net'> & { gross: string; fee: string; net: string }>(LINES_FOR_MATCHING, [
    currency,
    from,
    through,
  ])
  return rows.map((row) => ({ ...row, gross: BigInt(row.gross), fee: BigInt(row.fee), net: BigInt(row.net) }))
}

export async function replaceBreaks(client: Transaction, currency: string, from: number, through: number, breaks: readonly Break[]): Promise<void> {
  await client.query('DELETE FROM recon_breaks WHERE currency = $1 AND day BETWEEN $2 AND $3', [currency, from, through])
  if (breaks.length === 0) return
  await client.query(
    `INSERT INTO recon_breaks (currency, day, class, file_id, line, journal_ref, attempt_id, detail)
     SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::text[], $5::int[], $6::text[], $7::uuid[], $8::text[])`,
    [
      currency,
      breaks.map((b) => b.day),
      breaks.map((b) => b.class),
      breaks.map((b) => b.line?.fileId ?? null),
      breaks.map((b) => b.line?.line ?? null),
      breaks.map((b) => b.item?.journalRef ?? null),
      breaks.map((b) => b.item?.attemptId ?? null),
      breaks.map((b) => b.detail),
    ],
  )
}

export async function breaksIn(db: Queryable, currency: string, from: number, through: number): Promise<BreakView[]> {
  const { rows } = await db.query<BreakView>(
    `SELECT day::int AS day, class, file_id, line, journal_ref, attempt_id, detail
     FROM recon_breaks WHERE currency = $1 AND day BETWEEN $2 AND $3 ORDER BY day, class, id`,
    [currency, from, through],
  )
  return rows
}

export async function recentFiles(db: Queryable, currency: string, limit: number): Promise<FileSummaryRow[]> {
  const { rows } = await db.query<FileSummaryRow>(
    `SELECT f.day::int AS day, f.id, f.lines, f.gross::text, f.fee::text, f.net::text, f.journal_id::text, f.received_at,
            (SELECT jsonb_object_agg(class, n) FROM (SELECT class, count(*)::int AS n FROM recon_breaks b WHERE b.currency = f.currency AND b.day = f.day GROUP BY class) c) AS breaks
     FROM settlement_files f WHERE f.currency = $1 ORDER BY f.day DESC LIMIT $2`,
    [currency, limit],
  )
  return rows
}

export async function findFileOfDay(db: Queryable, currency: string, day: number): Promise<FileRow | undefined> {
  const { rows } = await db.query<FileRow>(
    'SELECT id, lines, gross::text, fee::text, net::text, journal_id::text, received_at FROM settlement_files WHERE currency = $1 AND day = $2',
    [currency, day],
  )
  return rows[0]
}

export async function linesOfFile(db: Queryable, fileId: string, limit: number): Promise<LineRow[]> {
  const { rows } = await db.query<LineRow>(
    `SELECT l.line, l.operation, l.reference, l.kind, l.gross::text, l.fee::text, l.net::text, l.operated_at,
            (SELECT b.class FROM recon_breaks b WHERE b.file_id = l.file_id AND b.line = l.line ORDER BY b.id LIMIT 1) AS break
     FROM settlement_lines l WHERE l.file_id = $1 ORDER BY (SELECT 1 FROM recon_breaks b WHERE b.file_id = l.file_id AND b.line = l.line LIMIT 1) NULLS LAST, l.line LIMIT $2`,
    [fileId, limit],
  )
  return rows
}
