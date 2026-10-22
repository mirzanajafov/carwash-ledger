import {
  canonicalJournal,
  chainHash,
  completedBy,
  consistencyProof,
  EMPTY_CHAIN,
  inclusionProof,
  leafHash,
  nodesFor,
  rootOf,
  type Hash,
  type Node,
  type SubtreeSource,
} from '@carwash/audit'
import { firstRow, type Queryable, type Transaction } from '@carwash/pg'

export const SEQUENCER_LOCK = 7_240_300

export interface Head {
  size: number
  root: Hash
  chain: Hash
}

export async function readNodes(db: Queryable, nodes: readonly Node[]): Promise<Map<string, Hash>> {
  const found = new Map<string, Hash>()
  if (nodes.length === 0) return found
  const { rows } = await db.query<{ level: number; idx: string; hash: Buffer }>(
    `SELECT n.level, n.idx::text AS idx, n.hash FROM audit_nodes n
     JOIN unnest($1::smallint[], $2::bigint[]) AS w(level, idx) ON w.level = n.level AND w.idx = n.idx`,
    [nodes.map((n) => n.level), nodes.map((n) => n.index)],
  )
  for (const row of rows) found.set(`${row.level}:${row.idx}`, new Uint8Array(row.hash))
  return found
}

function sourceOf(found: ReadonlyMap<string, Hash>): SubtreeSource {
  return (level, index) => {
    const hash = found.get(`${level}:${index}`)
    if (!hash) throw new Error(`the audit tree has no subtree ${level}:${index}`)
    return hash
  }
}

async function withNodes<T>(db: Queryable, read: (source: SubtreeSource) => T): Promise<T> {
  return read(sourceOf(await readNodes(db, nodesFor(read))))
}

export async function treeSize(db: Queryable): Promise<number> {
  return firstRow(await db.query<{ size: number }>('SELECT coalesce(max(seq) + 1, 0)::int AS size FROM audit_log')).size
}

export async function head(db: Queryable): Promise<Head> {
  const size = await treeSize(db)
  const root = await withNodes(db, (source) => rootOf(size, source))
  const { rows } = await db.query<{ chain: Buffer }>('SELECT chain FROM audit_log ORDER BY seq DESC LIMIT 1')
  return { size, root, chain: rows[0] ? new Uint8Array(rows[0].chain) : EMPTY_CHAIN }
}

export async function rootAt(db: Queryable, size: number): Promise<Hash> {
  return withNodes(db, (source) => rootOf(size, source))
}

export async function proveInclusion(db: Queryable, seq: number, size: number): Promise<Hash[]> {
  return withNodes(db, (source) => inclusionProof(seq, size, source))
}

export async function proveConsistency(db: Queryable, first: number, second: number): Promise<Hash[]> {
  return withNodes(db, (source) => consistencyProof(first, second, source))
}

export interface JournalRow {
  id: string
  external_ref: string
  micros: string
  entries: [string, string, string][]
}

export function canonicalOf(journal: JournalRow): Uint8Array {
  return canonicalJournal({
    id: BigInt(journal.id),
    externalRef: journal.external_ref,
    createdAtMicros: BigInt(journal.micros),
    entries: journal.entries.map(([id, accountId, amount]) => ({ id: BigInt(id), accountId: BigInt(accountId), amount: BigInt(amount) })),
  })
}

export async function sequenceBatch(client: Transaction, limit: number): Promise<number> {
  const { locked } = firstRow(await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [SEQUENCER_LOCK]))
  if (!locked) return 0
  const { rows: queued } = await client.query<{ journal_id: string }>('SELECT q.journal_id::text FROM audit_queue q ORDER BY q.journal_id LIMIT $1', [limit])
  if (queued.length === 0) return 0
  const ids = queued.map((q) => q.journal_id)
  const { rows: journals } = await client.query<JournalRow>(
    `SELECT j.id::text, j.external_ref, (extract(epoch FROM j.created_at) * 1000000)::bigint::text AS micros,
            json_agg(json_build_array(e.id::text, e.account_id::text, e.amount::text) ORDER BY e.id) AS entries
     FROM journals j JOIN entries e ON e.journal_id = j.id
     WHERE j.id = ANY($1::bigint[])
     GROUP BY j.id
     ORDER BY j.id`,
    [ids],
  )
  if (journals.length !== ids.length) throw new Error(`${ids.length - journals.length} queued journals have no rows`)
  const size = await treeSize(client)
  const frontier = await readNodes(
    client,
    nodesFor((source) => rootOf(size, source)),
  )
  const { rows: last } = await client.query<{ chain: Buffer }>('SELECT chain FROM audit_log ORDER BY seq DESC LIMIT 1')
  let chain: Hash = last[0] ? new Uint8Array(last[0].chain) : EMPTY_CHAIN
  const source = sourceOf(frontier)
  const seqs: number[] = []
  const leaves: Buffer[] = []
  const chains: Buffer[] = []
  const levels: number[] = []
  const indexes: number[] = []
  const hashes: Buffer[] = []
  journals.forEach((journal, offset) => {
    const leaf = leafHash(canonicalOf(journal))
    chain = chainHash(chain, leaf)
    const seq = size + offset
    seqs.push(seq)
    leaves.push(Buffer.from(leaf))
    chains.push(Buffer.from(chain))
    for (const node of completedBy(seq, leaf, source)) {
      frontier.set(`${node.level}:${node.index}`, node.hash)
      levels.push(node.level)
      indexes.push(node.index)
      hashes.push(Buffer.from(node.hash))
    }
  })
  await client.query('INSERT INTO audit_log (seq, journal_id, leaf, chain) SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bytea[], $4::bytea[])', [
    seqs,
    journals.map((j) => j.id),
    leaves,
    chains,
  ])
  await client.query('INSERT INTO audit_nodes (level, idx, hash) SELECT * FROM unnest($1::smallint[], $2::bigint[], $3::bytea[])', [levels, indexes, hashes])
  await client.query('DELETE FROM audit_queue WHERE journal_id = ANY($1::bigint[])', [ids])
  return journals.length
}
