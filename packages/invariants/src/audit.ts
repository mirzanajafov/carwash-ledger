import type pg from 'pg'
import { collect, EXAMPLES, inSnapshot, type Check } from './collect.ts'
import type { InvariantResult } from './types.ts'
import { checkWitnessedIn, type WitnessView } from './witness.ts'

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

function queued(graceSeconds: number): readonly Check[] {
  return [
    {
      sql: `SELECT 'journal ' || journal_id || ' has waited to be sequenced since ' || queued_at AS detail FROM audit_queue
            WHERE queued_at < now() - make_interval(secs => ${Math.max(0, Math.trunc(graceSeconds))})`,
    },
  ]
}

export async function checkAuditIn(client: pg.ClientBase, witness?: WitnessView): Promise<InvariantResult> {
  const s7 = await collect(client, AGREES)
  if (!witness) return { id: 'S7', description: 'the audit log agrees with the journals and with itself: leaves, chain and subtrees', ...s7 }
  const witnessed = await checkWitnessedIn(client, witness)
  return {
    id: 'S7',
    description: 'the audit log agrees with the journals, with itself and with every root the witness signed',
    count: s7.count + witnessed.count,
    examples: [...s7.examples, ...witnessed.examples].slice(0, EXAMPLES),
  }
}

export function checkAudit(pool: pg.Pool, witness?: WitnessView): Promise<InvariantResult> {
  return inSnapshot(pool, (client) => checkAuditIn(client, witness))
}

export interface SequencedOptions {
  graceSeconds?: number
}

export async function checkSequencedIn(client: pg.ClientBase, witness?: WitnessView, options: SequencedOptions = {}): Promise<InvariantResult> {
  const grace = options.graceSeconds ?? 0
  const l4 = await collect(client, queued(grace))
  const description = grace > 0 ? `every journal is sequenced into the audit log within ${grace} s` : 'every journal has been sequenced into the audit log'
  if (!witness) return { id: 'L4', description, ...l4 }
  const { rows } = await client.query<{ size: string }>('SELECT coalesce(max(seq) + 1, 0)::text AS size FROM audit_log')
  const size = Number(rows[0]!.size)
  const signed = witness.checkpoints.at(-1)?.size ?? 0
  const behind = signed < size ? [`the witness has signed ${signed} of ${size} leaves`] : []
  return {
    id: 'L4',
    description: 'every journal has been sequenced into the audit log, and the witness has signed all of it',
    count: l4.count + behind.length,
    examples: [...l4.examples, ...behind].slice(0, EXAMPLES),
  }
}

export function checkSequenced(pool: pg.Pool, witness?: WitnessView, options: SequencedOptions = {}): Promise<InvariantResult> {
  return inSnapshot(pool, (client) => checkSequencedIn(client, witness, options))
}
