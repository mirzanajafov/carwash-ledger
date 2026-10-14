import { leafHash, nodeHash, type Hash } from '@carwash/audit'
import type pg from 'pg'
import { canonicalOf, type JournalRow } from './log.ts'

export type TamperClass = 1 | 2 | 3

export interface Tampered {
  tamperClass: TamperClass
  seq: number
  journalId: string
}

const JOURNAL = `
  SELECT j.id::text, j.external_ref, (extract(epoch FROM j.created_at) * 1000000)::bigint::text AS micros,
         json_agg(json_build_array(e.id::text, e.account_id::text, e.amount::text) ORDER BY e.id) AS entries
  FROM journals j JOIN entries e ON e.journal_id = j.id
  WHERE j.id = $1
  GROUP BY j.id`

const RECHAIN = `
  WITH RECURSIVE rechained(seq, chain) AS (
    SELECT a.seq, sha256(coalesce((SELECT p.chain FROM audit_log p WHERE p.seq = a.seq - 1), decode(repeat('00', 32), 'hex')) || a.leaf)
    FROM audit_log a WHERE a.seq = $1
    UNION ALL
    SELECT a.seq, sha256(r.chain || a.leaf) FROM rechained r JOIN audit_log a ON a.seq = r.seq + 1
  )
  UPDATE audit_log a SET chain = r.chain FROM rechained r WHERE a.seq = r.seq`

async function moveCents(client: pg.ClientBase, journalId: string, cents: number): Promise<void> {
  const moved = await client.query(
    `WITH plus AS (SELECT id FROM entries WHERE journal_id = $1 AND amount > 0 ORDER BY id LIMIT 1),
          minus AS (SELECT id FROM entries WHERE journal_id = $1 AND amount < 0 ORDER BY id LIMIT 1)
     UPDATE entries SET amount = amount + CASE WHEN id IN (SELECT id FROM plus) THEN $2::bigint ELSE -$2::bigint END
     WHERE id IN (SELECT id FROM plus UNION ALL SELECT id FROM minus)`,
    [journalId, cents],
  )
  if (moved.rowCount !== 2) throw new Error(`journal ${journalId} has no pair of entries to move cents between`)
}

async function rewriteHashes(client: pg.ClientBase, seq: number, journalId: string): Promise<void> {
  const { rows } = await client.query<JournalRow>(JOURNAL, [journalId])
  let hash: Hash = leafHash(canonicalOf(rows[0]!))
  await client.query('UPDATE audit_log SET leaf = $2 WHERE seq = $1', [seq, Buffer.from(hash)])
  await client.query(RECHAIN, [seq])
  await client.query('UPDATE audit_nodes SET hash = $2 WHERE level = 0 AND idx = $1', [seq, Buffer.from(hash)])
  let index = seq
  for (let level = 1; ; level++) {
    const parent = Math.floor(index / 2)
    const sibling = index % 2 === 0 ? index + 1 : index - 1
    const { rows: found } = await client.query<{ hash: Buffer }>(
      `SELECT s.hash FROM audit_nodes s
       WHERE s.level = $1 - 1 AND s.idx = $3
         AND EXISTS (SELECT 1 FROM audit_nodes p WHERE p.level = $1 AND p.idx = $2)`,
      [level, parent, sibling],
    )
    if (!found[0]) return
    const other = new Uint8Array(found[0].hash)
    hash = index % 2 === 0 ? nodeHash(hash, other) : nodeHash(other, hash)
    await client.query('UPDATE audit_nodes SET hash = $3 WHERE level = $1 AND idx = $2', [level, parent, Buffer.from(hash)])
    index = parent
  }
}

export async function tamper(client: pg.ClientBase, tamperClass: TamperClass, seq: number, cents = 100): Promise<Tampered> {
  await client.query('SET LOCAL session_replication_role = replica')
  const { rows } = await client.query<{ journal_id: string }>('SELECT journal_id::text FROM audit_log WHERE seq = $1', [seq])
  if (!rows[0]) throw new Error(`the audit log has no seq ${seq}`)
  const journalId = rows[0].journal_id
  if (tamperClass === 3) {
    await client.query('DELETE FROM entries WHERE journal_id = $1', [journalId])
    await client.query('DELETE FROM journals WHERE id = $1', [journalId])
  } else {
    await moveCents(client, journalId, cents)
    if (tamperClass === 2) await rewriteHashes(client, seq, journalId)
  }
  return { tamperClass, seq, journalId }
}
