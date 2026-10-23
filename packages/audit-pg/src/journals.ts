import { canonicalJournal } from '@carwash/audit'
import type { Queryable } from '@carwash/pg'

export const MICROS = '(extract(epoch FROM j.created_at) * 1000000)::bigint::text'

export const ENTRIES = 'json_agg(json_build_array(e.id::text, e.account_id::text, e.amount::text) ORDER BY e.id)'

export interface JournalRow {
  id: string
  external_ref: string
  micros: string
  entries: [string, string, string][]
}

export interface JournalWithEntries {
  id: string
  external_ref: string
  micros: string
  created_at: Date
  seq: string | null
  entries: { id: string; account_id: string; account: string; amount: string }[]
}

export function canonicalOf(journal: JournalRow): Uint8Array {
  return canonicalJournal({
    id: BigInt(journal.id),
    externalRef: journal.external_ref,
    createdAtMicros: BigInt(journal.micros),
    entries: journal.entries.map(([id, accountId, amount]) => ({ id: BigInt(id), accountId: BigInt(accountId), amount: BigInt(amount) })),
  })
}

export async function readJournals(db: Queryable, ids: readonly string[]): Promise<JournalRow[]> {
  const { rows } = await db.query<JournalRow>(
    `SELECT j.id::text, j.external_ref, ${MICROS} AS micros, ${ENTRIES} AS entries
     FROM journals j JOIN entries e ON e.journal_id = j.id
     WHERE j.id = ANY($1::bigint[])
     GROUP BY j.id
     ORDER BY j.id`,
    [ids],
  )
  return rows
}

export async function findJournal(db: Queryable, id: string): Promise<JournalWithEntries | undefined> {
  const { rows } = await db.query<JournalWithEntries>(
    `SELECT j.id::text, j.external_ref, ${MICROS} AS micros, j.created_at,
            (SELECT a.seq::text FROM audit_log a WHERE a.journal_id = j.id) AS seq,
            json_agg(json_build_object('id', e.id::text, 'account_id', e.account_id::text, 'account', acc.code, 'amount', e.amount::text) ORDER BY e.id) AS entries
     FROM journals j JOIN entries e ON e.journal_id = j.id JOIN accounts acc ON acc.id = e.account_id
     WHERE j.id = $1 GROUP BY j.id`,
    [id],
  )
  return rows[0]
}
