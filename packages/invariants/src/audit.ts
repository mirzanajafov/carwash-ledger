import type pg from 'pg'
import { collect, inSnapshot, type Check } from './collect.ts'
import type { InvariantResult } from './types.ts'

const CANONICAL = `
  canonical AS (
    SELECT j.id,
           '\\x01'::bytea || int8send(j.id)
           || int4send(octet_length(convert_to(j.external_ref, 'UTF8'))) || convert_to(j.external_ref, 'UTF8')
           || int8send((extract(epoch FROM j.created_at) * 1000000)::bigint)
           || int4send(count(e.id)::int)
           || string_agg(int8send(e.id) || int8send(e.account_id) || int8send(e.amount), ''::bytea ORDER BY e.id) AS bytes
    FROM journals j JOIN entries e ON e.journal_id = j.id
    GROUP BY j.id
  )`

const AGREES: readonly Check[] = [
  {
    sql: `
      WITH ${CANONICAL}
      SELECT 'seq ' || a.seq || ' (journal ' || a.journal_id || ') ' ||
             CASE WHEN c.id IS NULL THEN 'has no journal any more' ELSE 'does not match its journal' END AS detail
      FROM audit_log a LEFT JOIN canonical c ON c.id = a.journal_id
      WHERE c.id IS NULL OR sha256('\\x00'::bytea || c.bytes) <> a.leaf`,
  },
  {
    sql: `
      SELECT 'journal ' || j.id || ' is neither sequenced nor queued' AS detail
      FROM journals j
      WHERE NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.journal_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM audit_queue q WHERE q.journal_id = j.id)`,
  },
  {
    sql: `
      SELECT 'seq ' || seq || ' does not chain from the one before it' AS detail
      FROM (
        SELECT seq, leaf, chain, lag(chain) OVER (ORDER BY seq) AS previous, lag(seq) OVER (ORDER BY seq) AS previous_seq
        FROM audit_log
      ) s
      WHERE chain <> sha256(coalesce(previous, '\\x0000000000000000000000000000000000000000000000000000000000000000'::bytea) || leaf)
         OR seq <> coalesce(previous_seq + 1, 0)`,
  },
  {
    sql: `
      SELECT 'subtree ' || n.level || ':' || n.idx || ' does not hash its ' ||
             CASE WHEN n.level = 0 THEN 'leaf' ELSE 'children' END AS detail
      FROM audit_nodes n
      LEFT JOIN audit_log a ON n.level = 0 AND a.seq = n.idx
      LEFT JOIN audit_nodes l ON n.level > 0 AND l.level = n.level - 1 AND l.idx = 2 * n.idx
      LEFT JOIN audit_nodes r ON n.level > 0 AND r.level = n.level - 1 AND r.idx = 2 * n.idx + 1
      WHERE (n.level = 0 AND (a.seq IS NULL OR a.leaf <> n.hash))
         OR (n.level > 0 AND (l.hash IS NULL OR r.hash IS NULL OR sha256('\\x01'::bytea || l.hash || r.hash) <> n.hash))`,
  },
  {
    sql: `
      WITH size AS (SELECT coalesce(max(seq) + 1, 0) AS n FROM audit_log),
           levels AS (SELECT generate_series(0, 62) AS level),
           expected AS (SELECT level, (SELECT n FROM size) / (1::bigint << level) AS complete FROM levels),
           stored AS (SELECT level, count(*) AS complete FROM audit_nodes GROUP BY level)
      SELECT 'level ' || e.level || ' has ' || coalesce(s.complete, 0) || ' complete subtrees, the tree needs ' || e.complete AS detail
      FROM expected e LEFT JOIN stored s ON s.level = e.level
      WHERE coalesce(s.complete, 0) <> e.complete`,
  },
]

const QUEUED: readonly Check[] = [
  {
    sql: `SELECT 'journal ' || journal_id || ' has waited to be sequenced since ' || queued_at AS detail FROM audit_queue`,
  },
]

export async function checkAuditIn(client: pg.ClientBase): Promise<InvariantResult> {
  const s7 = await collect(client, AGREES)
  return { id: 'S7', description: 'the audit log agrees with the journals and with itself: leaves, chain and subtrees', ...s7 }
}

export function checkAudit(pool: pg.Pool): Promise<InvariantResult> {
  return inSnapshot(pool, checkAuditIn)
}

export async function checkSequencedIn(client: pg.ClientBase): Promise<InvariantResult> {
  const l4 = await collect(client, QUEUED)
  return { id: 'L4', description: 'every journal has been sequenced into the audit log', ...l4 }
}

export function checkSequenced(pool: pg.Pool): Promise<InvariantResult> {
  return inSnapshot(pool, checkSequencedIn)
}
