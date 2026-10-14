import { createPublicKey, verify } from 'node:crypto'
import { chainHash, checkpointBody, EMPTY_CHAIN, equal, Frontier, fromHex, leafHash, toHex, type FrontierState, type Hash } from '@carwash/audit'
import type pg from 'pg'
import { canonicalOf, rootAt, treeSize, type JournalRow } from './log.ts'

type Queryable = pg.ClientBase | pg.Pool

export interface SignedRoot {
  size: number
  root: string
  signature: string
}

export interface WitnessedRoots {
  origin: string
  publicKey: string
  checkpoints: readonly SignedRoot[]
}

export interface VerifierState extends FrontierState {
  chain: string
  root: string
}

export type Finding =
  | { kind: 'missing_journal'; seq: number; journalId: string }
  | { kind: 'leaf'; seq: number; journalId: string }
  | { kind: 'chain'; seq: number }
  | { kind: 'gap'; seq: number; missing: number }
  | { kind: 'root'; size: number; after: number }
  | { kind: 'signature'; size: number }
  | { kind: 'beyond'; size: number; treeSize: number }
  | { kind: 'history'; size: number; what: 'chain' | 'root' }
  | { kind: 'unsequenced'; journalId: string }

export interface VerifyOptions {
  witness?: WitnessedRoots
  from?: VerifierState
  batch?: number
  examples?: number
}

export interface VerifyReport {
  mode: 'full' | 'incremental'
  from: number
  size: number
  journals: number
  witnessed: number
  findings: number
  examples: Finding[]
  firstSeq: number | null
  state: VerifierState | null
  ms: { read: number; compute: number; total: number }
}

interface Row extends JournalRow {
  seq: string
  journal_id: string
  present: boolean
  leaf: Buffer
  chain: Buffer
}

const ROWS = `
  SELECT a.seq::text, a.journal_id::text, a.leaf, a.chain, j.id IS NOT NULL AS present, j.id::text AS id, j.external_ref,
         (extract(epoch FROM j.created_at) * 1000000)::bigint::text AS micros,
         coalesce(json_agg(json_build_array(e.id::text, e.account_id::text, e.amount::text) ORDER BY e.id) FILTER (WHERE e.id IS NOT NULL), '[]') AS entries
  FROM audit_log a
  LEFT JOIN journals j ON j.id = a.journal_id
  LEFT JOIN entries e ON e.journal_id = j.id
  WHERE a.seq >= $1 AND a.seq < $2
  GROUP BY a.seq, a.journal_id, a.leaf, a.chain, j.id
  ORDER BY a.seq`

const UNSEQUENCED = `
  SELECT j.id::text AS id FROM journals j
  WHERE NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.journal_id = j.id)
    AND NOT EXISTS (SELECT 1 FROM audit_queue q WHERE q.journal_id = j.id)
  ORDER BY j.id`

function signedRoots(witness: WitnessedRoots | undefined, report: (finding: Finding) => void): SignedRoot[] {
  if (!witness) return []
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: witness.publicKey }, format: 'jwk' })
  const good: SignedRoot[] = []
  for (const checkpoint of [...witness.checkpoints].sort((a, b) => a.size - b.size)) {
    const body = Buffer.from(checkpointBody(checkpoint, witness.origin))
    if (verify(null, body, key, Buffer.from(checkpoint.signature, 'base64'))) good.push(checkpoint)
    else report({ kind: 'signature', size: checkpoint.size })
  }
  return good
}

export async function verifyLog(db: Queryable, options: VerifyOptions = {}): Promise<VerifyReport> {
  const started = performance.now()
  const batch = options.batch ?? 5000
  const limit = options.examples ?? 20
  const examples: Finding[] = []
  let findings = 0
  let exact: number | null = null
  let ranged: number | null = null
  const report = (finding: Finding) => {
    findings++
    if (examples.length < limit) examples.push(finding)
    if ('seq' in finding && (exact === null || finding.seq < exact)) exact = finding.seq
    if (finding.kind === 'root' && (ranged === null || finding.after < ranged)) ranged = finding.after
  }
  let read = 0
  const timed = async <T>(work: () => Promise<T>): Promise<T> => {
    const at = performance.now()
    try {
      return await work()
    } finally {
      read += performance.now() - at
    }
  }

  const start = options.from?.size ?? 0
  const size = await timed(() => treeSize(db))
  const frontier = options.from ? Frontier.from(options.from) : new Frontier()
  let chain: Hash = options.from ? fromHex(options.from.chain) : EMPTY_CHAIN
  let storedChain: Hash = chain
  let broken = false

  if (options.from && start > 0) {
    const { rows } = await timed(() => db.query<{ chain: Buffer }>('SELECT chain FROM audit_log WHERE seq = $1', [start - 1]))
    if (!rows[0] || !equal(new Uint8Array(rows[0].chain), chain)) report({ kind: 'history', size: start, what: 'chain' })
    if (rows[0]) storedChain = new Uint8Array(rows[0].chain)
    const stored = start <= size ? await timed(() => rootAt(db, start)).catch(() => undefined) : undefined
    if (!stored || toHex(stored) !== options.from.root) report({ kind: 'history', size: start, what: 'root' })
  }

  const checkpoints = signedRoots(options.witness, report).filter((c) => c.size > start)
  let next = 0
  let lastMatched = start
  let journals = 0
  let position = start
  for (let from = start; from < size; from += batch) {
    const { rows } = await timed(() => db.query<Row>(ROWS, [from, Math.min(from + batch, size)]))
    for (const row of rows) {
      const seq = Number(row.seq)
      if (seq !== position) {
        report({ kind: 'gap', seq: position, missing: seq - position })
        broken = true
      }
      position = seq + 1
      journals++
      const stored: Hash = new Uint8Array(row.leaf)
      let leaf = stored
      if (!row.present) {
        report({ kind: 'missing_journal', seq, journalId: row.journal_id })
      } else {
        leaf = leafHash(canonicalOf(row))
        if (!equal(leaf, stored)) report({ kind: 'leaf', seq, journalId: row.journal_id })
      }
      const storedNext = new Uint8Array(row.chain)
      if (!equal(storedNext, chainHash(storedChain, stored))) report({ kind: 'chain', seq })
      storedChain = storedNext
      chain = chainHash(chain, leaf)
      if (broken) continue
      frontier.push(leaf)
      while (next < checkpoints.length && checkpoints[next]!.size <= frontier.size) {
        const checkpoint = checkpoints[next++]!
        if (checkpoint.size < frontier.size) continue
        if (toHex(frontier.root()) === checkpoint.root) lastMatched = checkpoint.size
        else report({ kind: 'root', size: checkpoint.size, after: lastMatched })
      }
    }
  }
  if (position < size) {
    report({ kind: 'gap', seq: position, missing: size - position })
    broken = true
  }
  for (const checkpoint of checkpoints.slice(next)) {
    if (checkpoint.size > size) report({ kind: 'beyond', size: checkpoint.size, treeSize: size })
  }
  if (!options.from) {
    const { rows } = await timed(() => db.query<{ id: string }>(UNSEQUENCED))
    for (const row of rows) report({ kind: 'unsequenced', journalId: row.id })
  }

  const total = performance.now() - started
  return {
    mode: options.from ? 'incremental' : 'full',
    from: start,
    size,
    journals,
    witnessed: next,
    findings,
    examples,
    firstSeq: exact ?? ranged,
    state: broken ? null : { ...frontier.toJSON(), chain: toHex(chain), root: toHex(frontier.root()) },
    ms: { read: Math.round(read), compute: Math.round(total - read), total: Math.round(total) },
  }
}
