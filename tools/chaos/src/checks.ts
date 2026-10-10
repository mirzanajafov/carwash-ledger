import type pg from 'pg'
import type { LedgerJournal } from './compare.ts'

export async function fetchJournals(pool: pg.Pool): Promise<LedgerJournal[]> {
  const result = await pool.query<{ id: string; external_ref: string; reverses_id: string | null; entries: [string, string][] }>(`
    SELECT j.id::text AS id,
           j.external_ref,
           j.reverses_id::text AS reverses_id,
           coalesce(
             json_agg(json_build_array(e.account_id::text, e.amount::text) ORDER BY e.id) FILTER (WHERE e.id IS NOT NULL),
             '[]'
           ) AS entries
    FROM journals j
    LEFT JOIN entries e ON e.journal_id = j.id
    GROUP BY j.id`)
  return result.rows.map((row) => ({
    id: row.id,
    externalRef: row.external_ref,
    reversesId: row.reverses_id,
    entries: row.entries.map(([accountId, amount]) => ({ accountId, amount })),
  }))
}
