import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { chainHash, EMPTY_CHAIN, equal, Frontier, fromHex, leafHash, toHex, type FrontierState, type Hash, type SignedCheckpoint } from '@carwash/audit'
import type { Queryable, Transaction } from '@carwash/pg'
import { canonicalOf, ENTRIES, MICROS, type JournalRow } from './journals.ts'
import { rootAt, treeSize } from './log.ts'
import { ed25519PublicKey, isSignedBy } from './witness-key.ts'

const TURN_MS = 10

export interface WitnessAnchor {
  origin: string
  publicKey: string
  latest: SignedCheckpoint | undefined
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
  witness?: WitnessAnchor | undefined
  from?: VerifierState | undefined
  batch?: number
  examples?: number
  signal?: AbortSignal
  onProgress?: (done: number, size: number) => Promise<void>
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
  ms: { read: number; compute: number; yielded: number; total: number }
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
         ${MICROS} AS micros, coalesce(${ENTRIES} FILTER (WHERE e.id IS NOT NULL), '[]') AS entries
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

const COPIES = `
  SELECT c.size::text, c.root, c.signature FROM audit_checkpoints c
  WHERE c.size > $1 AND c.size <= $2 AND c.witness_key = $3
  ORDER BY c.size`

class Findings {
  count = 0
  readonly examples: Finding[] = []
  readonly #limit: number
  #exact: number | null = null
  #ranged: number | null = null

  constructor(limit: number) {
    this.#limit = limit
  }

  add(finding: Finding): void {
    this.count++
    if (this.examples.length < this.#limit) this.examples.push(finding)
    if ('seq' in finding && (this.#exact === null || finding.seq < this.#exact)) this.#exact = finding.seq
    if (finding.kind === 'root' && (this.#ranged === null || finding.after < this.#ranged)) this.#ranged = finding.after
  }

  get firstSeq(): number | null {
    return this.#exact ?? this.#ranged
  }
}

async function claimedRoots(db: Queryable, witness: WitnessAnchor, above: number, through: number): Promise<SignedCheckpoint[]> {
  const { latest } = witness
  const { rows } = await db.query<{ size: string; root: Buffer; signature: Buffer }>(COPIES, [above, through, witness.publicKey])
  const roots = rows.map((row) => ({ size: Number(row.size), root: row.root.toString('hex'), signature: row.signature.toString('base64') }))
  const isLatest = (root: SignedCheckpoint) => root.size === latest?.size && root.root === latest.root && root.signature === latest.signature
  if (latest && latest.size > above && latest.size <= through && !roots.some(isLatest)) roots.push(latest)
  return roots.sort((a, b) => a.size - b.size)
}

export async function verifyLog(db: Transaction, options: VerifyOptions = {}): Promise<VerifyReport> {
  const started = performance.now()
  const batch = options.batch ?? 5000
  if (!Number.isSafeInteger(batch) || batch < 1) throw new RangeError(`the batch must be a positive integer, not ${batch}`)
  const findings = new Findings(options.examples ?? 20)
  let yielded = 0
  let turnAt = performance.now()
  const handBack = async (work: () => Promise<unknown>) => {
    const at = performance.now()
    await work()
    turnAt = performance.now()
    yielded += turnAt - at
  }
  const turn = () => handBack(() => yieldToLoop(undefined, { signal: options.signal }))
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
    if (!rows[0] || !equal(new Uint8Array(rows[0].chain), chain)) findings.add({ kind: 'history', size: start, what: 'chain' })
    if (rows[0]) storedChain = new Uint8Array(rows[0].chain)
    const stored = start <= size ? await timed(() => rootAt(db, start)).catch(() => undefined) : undefined
    if (!stored || toHex(stored) !== options.from.root) findings.add({ kind: 'history', size: start, what: 'root' })
  }

  const witness = options.witness && { ...options.witness, key: ed25519PublicKey(options.witness.publicKey) }
  const signedRoots = async (above: number, through: number): Promise<SignedCheckpoint[]> => {
    if (!witness) return []
    const good: SignedCheckpoint[] = []
    for (const root of await timed(() => claimedRoots(db, witness, above, through))) {
      if (performance.now() - turnAt >= TURN_MS) await turn()
      if (isSignedBy(root, witness.key, witness.origin)) good.push(root)
      else findings.add({ kind: 'signature', size: root.size })
    }
    return good
  }

  let witnessed = 0
  let lastMatched = start
  let journals = 0
  let position = start
  for (let from = start; from < size; from += batch) {
    options.signal?.throwIfAborted()
    const to = Math.min(from + batch, size)
    const { rows } = await timed(() => db.query<Row>(ROWS, [from, to]))
    const roots = await signedRoots(from, to)
    let next = 0
    for (const row of rows) {
      if (performance.now() - turnAt >= TURN_MS) await turn()
      const seq = Number(row.seq)
      if (seq !== position) {
        findings.add({ kind: 'gap', seq: position, missing: seq - position })
        broken = true
      }
      position = seq + 1
      journals++
      const stored: Hash = new Uint8Array(row.leaf)
      let leaf = stored
      if (!row.present) {
        findings.add({ kind: 'missing_journal', seq, journalId: row.journal_id })
      } else {
        leaf = leafHash(canonicalOf(row))
        if (!equal(leaf, stored)) findings.add({ kind: 'leaf', seq, journalId: row.journal_id })
      }
      const storedNext = new Uint8Array(row.chain)
      if (!equal(storedNext, chainHash(storedChain, stored))) findings.add({ kind: 'chain', seq })
      storedChain = storedNext
      chain = chainHash(chain, leaf)
      if (broken) continue
      frontier.push(leaf)
      for (let root = roots[next]; root?.size === frontier.size; root = roots[++next]) {
        witnessed++
        if (toHex(frontier.root()) === root.root) lastMatched = frontier.size
        else findings.add({ kind: 'root', size: frontier.size, after: lastMatched })
      }
    }
    await handBack(async () => options.onProgress?.(to, size))
  }
  options.signal?.throwIfAborted()
  if (position < size) {
    findings.add({ kind: 'gap', seq: position, missing: size - position })
    broken = true
  }
  for (const root of await signedRoots(size, Number.MAX_SAFE_INTEGER)) findings.add({ kind: 'beyond', size: root.size, treeSize: size })
  if (!options.from) {
    const { rows } = await timed(() => db.query<{ id: string }>(UNSEQUENCED))
    for (const row of rows) findings.add({ kind: 'unsequenced', journalId: row.id })
  }

  const total = performance.now() - started
  return {
    mode: options.from ? 'incremental' : 'full',
    from: start,
    size,
    journals,
    witnessed,
    findings: findings.count,
    examples: findings.examples,
    firstSeq: findings.firstSeq,
    state: broken ? null : { ...frontier.toJSON(), chain: toHex(chain), root: toHex(frontier.root()) },
    ms: { read: Math.round(read), compute: Math.round(total - read - yielded), yielded: Math.round(yielded), total: Math.round(total) },
  }
}
