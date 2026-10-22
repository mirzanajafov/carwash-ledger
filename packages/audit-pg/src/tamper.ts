import { leafHash, nodeHash, type Hash } from '@carwash/audit'
import { firstRow, type Transaction } from '@carwash/pg'
import { canonicalOf, SEQUENCER_LOCK, type JournalRow } from './log.ts'

export type TamperClass = 1 | 2 | 3

export interface Tampered {
  tamperClass: TamperClass
  seq: number
  journalId: string
  undo: { amounts?: { id: string; amount: string }[]; journal?: string; entries?: string }
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

async function moveCents(client: Transaction, journalId: string, cents: number): Promise<{ id: string; amount: string }[]> {
  const { rows } = await client.query<{ id: string; amount: string }>(
    `WITH plus AS (SELECT id FROM entries WHERE journal_id = $1 AND amount > 0 ORDER BY id LIMIT 1),
          minus AS (SELECT id FROM entries WHERE journal_id = $1 AND amount < 0 ORDER BY id LIMIT 1),
          before AS (SELECT id, amount FROM entries WHERE id IN (SELECT id FROM plus UNION ALL SELECT id FROM minus))
     UPDATE entries e SET amount = e.amount + CASE WHEN e.id IN (SELECT id FROM plus) THEN $2::bigint ELSE -$2::bigint END
     FROM before b WHERE e.id = b.id
     RETURNING e.id::text, b.amount::text`,
    [journalId, cents],
  )
  if (rows.length !== 2) throw new Error(`journal ${journalId} has no pair of entries to move cents between`)
  return rows
}

async function rewriteHashes(client: Transaction, seq: number, journalId: string): Promise<void> {
  let hash: Hash = leafHash(canonicalOf(firstRow(await client.query<JournalRow>(JOURNAL, [journalId]))))
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

export async function tamper(client: Transaction, tamperClass: TamperClass, seq: number, cents = 100): Promise<Tampered> {
  await client.query('SET LOCAL session_replication_role = replica')
  await client.query('SELECT pg_advisory_xact_lock($1)', [SEQUENCER_LOCK])
  const { rows } = await client.query<{ journal_id: string }>('SELECT journal_id::text FROM audit_log WHERE seq = $1', [seq])
  if (!rows[0]) throw new Error(`the audit log has no seq ${seq}`)
  const journalId = rows[0].journal_id
  if (tamperClass === 3) {
    const entries = await client.query<{ rows: string }>(
      `WITH gone AS (DELETE FROM entries WHERE journal_id = $1 RETURNING *) SELECT jsonb_agg(to_jsonb(gone.*))::text AS rows FROM gone`,
      [journalId],
    )
    const journal = await client.query<{ row: string }>('DELETE FROM journals WHERE id = $1 RETURNING to_jsonb(journals.*)::text AS row', [journalId])
    return { tamperClass, seq, journalId, undo: { journal: firstRow(journal).row, entries: firstRow(entries).rows } }
  }
  const amounts = await moveCents(client, journalId, cents)
  if (tamperClass === 2) await rewriteHashes(client, seq, journalId)
  return { tamperClass, seq, journalId, undo: { amounts } }
}

export async function restore(client: Transaction, tampered: Tampered): Promise<void> {
  await client.query('SET LOCAL session_replication_role = replica')
  await client.query('SELECT pg_advisory_xact_lock($1)', [SEQUENCER_LOCK])
  if (tampered.tamperClass === 3) {
    await client.query('INSERT INTO journals SELECT * FROM jsonb_populate_record(NULL::journals, $1::jsonb)', [tampered.undo.journal])
    await client.query('INSERT INTO entries SELECT * FROM jsonb_populate_recordset(NULL::entries, $1::jsonb)', [tampered.undo.entries])
    return
  }
  for (const { id, amount } of tampered.undo.amounts ?? []) await client.query('UPDATE entries SET amount = $2 WHERE id = $1', [id, amount])
  if (tampered.tamperClass === 2) await rewriteHashes(client, tampered.seq, tampered.journalId)
}
