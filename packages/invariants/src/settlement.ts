import type pg from 'pg'
import { collect, inSnapshot, type Check } from './collect.ts'
import type { InvariantResult } from './types.ts'

export interface SettlementChecks {
  daySeconds: number
  feeBps: number
  feeFixed: number
  completeThrough?: number
}

const RECEIVABLE = `
  money AS (
    SELECT j.external_ref, sum(e.amount) AS receivable
    FROM journals j
    JOIN entries e ON e.journal_id = j.id
    JOIN accounts acc ON acc.id = e.account_id AND acc.code LIKE 'psp_receivable:%'
    WHERE j.external_ref LIKE 'capture:%' OR j.external_ref LIKE 'refund:%'
    GROUP BY j.external_ref
  )`

const SETTLED: readonly Check[] = [
  {
    sql: `
      WITH posted AS (
        SELECT f.id,
               coalesce(sum(e.amount) FILTER (WHERE acc.code LIKE 'bank:%'), 0) AS bank,
               coalesce(sum(e.amount) FILTER (WHERE acc.code LIKE 'psp_fee_expense:%'), 0) AS fee,
               coalesce(sum(e.amount) FILTER (WHERE acc.code LIKE 'psp_receivable:%'), 0) AS receivable
        FROM settlement_files f
        LEFT JOIN journals j ON j.external_ref = 'settlement:' || f.id
        LEFT JOIN entries e ON e.journal_id = j.id
        LEFT JOIN accounts acc ON acc.id = e.account_id
        GROUP BY f.id
      ),
      listed AS (
        SELECT f.id, coalesce(sum(l.gross), 0) AS gross, coalesce(sum(l.fee), 0) AS fee, coalesce(sum(l.net), 0) AS net, count(l.line) AS lines
        FROM settlement_files f LEFT JOIN settlement_lines l ON l.file_id = f.id
        GROUP BY f.id
      )
      SELECT 'file ' || f.id || ' says ' || f.gross || ' gross, ' || f.fee || ' fee, ' || f.net || ' net in ' || f.lines
             || ' lines, while its lines add up to ' || x.gross || ', ' || x.fee || ', ' || x.net || ' in ' || x.lines
             || ' and its journal moved ' || -p.receivable || ', ' || p.fee || ', ' || p.bank AS detail
      FROM settlement_files f JOIN posted p ON p.id = f.id JOIN listed x ON x.id = f.id
      WHERE p.bank <> f.net OR p.fee <> f.fee OR p.receivable <> -f.gross
         OR x.gross <> f.gross OR x.fee <> f.fee OR x.net <> f.net OR x.lines <> f.lines`,
  },
  {
    sql: `
      WITH ${RECEIVABLE}
      SELECT 'line ' || l.file_id || '/' || l.line || ' (' || l.kind || ' of ' || l.gross || ', fee ' || l.fee || ', reference '
             || coalesce(nullif(l.reference, ''), 'none') || ') ' ||
             CASE WHEN a.id IS NULL THEN 'has no attempt'
                  WHEN m.receivable IS NULL THEN 'has no journal'
                  WHEN m.receivable <> l.gross THEN 'disagrees with the ledger''s ' || m.receivable
                  ELSE 'has the wrong fee' END AS detail
      FROM settlement_lines l
      LEFT JOIN attempts a ON a.id::text = l.reference AND a.kind::text = l.kind AND a.status = 'succeeded'
      LEFT JOIN money m ON m.external_ref = CASE WHEN a.kind = 'capture' THEN 'capture:' || a.payment_id ELSE 'refund:' || a.refund_id END
      WHERE NOT EXISTS (SELECT 1 FROM attempts x JOIN anomalies n ON n.attempt_id = x.id WHERE x.id::text = l.reference)
        AND (a.id IS NULL OR m.receivable IS NULL OR m.receivable <> l.gross
             OR l.fee <> CASE WHEN l.kind = 'capture' THEN (abs(m.receivable)::bigint * $1 + 5000) / 10000 + $2 ELSE 0 END)`,
  },
  {
    sql: `
      SELECT 'reference ' || l.reference || ' is settled ' || count(*) || ' times' AS detail
      FROM settlement_lines l
      WHERE l.reference <> ''
      GROUP BY l.reference
      HAVING count(*) > 1`,
  },
  {
    sql: `
      SELECT 'attempt ' || a.id || ' (' || a.kind || ' of ' || a.amount || ') resolved on day '
             || floor(extract(epoch FROM a.resolved_at) / $3)::bigint || ' and is in no file' AS detail
      FROM attempts a
      WHERE a.kind IN ('capture', 'refund') AND a.status = 'succeeded'
        AND floor(extract(epoch FROM a.resolved_at) / $3) <= $4
        AND NOT EXISTS (SELECT 1 FROM settlement_lines l WHERE l.reference = a.id::text)`,
  },
]

function bound(sql: string, values: readonly unknown[]): string {
  return sql.replace(/\$(\d)/g, (_, n: string) => String(values[Number(n) - 1]))
}

export async function checkSettlementIn(client: pg.ClientBase, options: SettlementChecks): Promise<InvariantResult> {
  let through = options.completeThrough
  if (through === undefined) {
    const { rows } = await client.query<{ day: number | null }>('SELECT max(day)::int - 1 AS day FROM settlement_files')
    through = rows[0]!.day ?? -1
  }
  const values = [Math.trunc(options.feeBps), Math.trunc(options.feeFixed), Math.trunc(options.daySeconds), Math.trunc(through)]
  const l5 = await collect(
    client,
    SETTLED.map((check) => ({ sql: bound(check.sql, values) })),
  )
  return { id: 'L5', description: 'the settlement files agree with the ledger, line by line and in their journals', ...l5 }
}

export function checkSettlement(pool: pg.Pool, options: SettlementChecks): Promise<InvariantResult> {
  return inSnapshot(pool, (client) => checkSettlementIn(client, options))
}
