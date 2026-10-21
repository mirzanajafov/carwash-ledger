import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import type pg from 'pg'
import type { Finding } from './collect.ts'

export interface WitnessedCheckpoint {
  size: number
  root: string
  signature: string
}

export interface WitnessView {
  origin: string
  publicKey: string
  key: KeyObject
  latest: WitnessedCheckpoint | undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCheckpoint(value: unknown): value is WitnessedCheckpoint {
  return (
    isObject(value) &&
    typeof value.size === 'number' &&
    Number.isSafeInteger(value.size) &&
    value.size >= 1 &&
    typeof value.root === 'string' &&
    typeof value.signature === 'string'
  )
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  const body: unknown = await response.json().catch(() => undefined)
  if (response.ok && body === undefined) throw new Error(`GET ${url} answered ${response.status} with a body that is not JSON`)
  if (response.ok) return body
  if (response.status === 404 && isObject(body) && isObject(body.error) && body.error.code === 'none') return undefined
  throw new Error(`GET ${url} answered ${response.status}`)
}

function publicKeyOf(x: string): KeyObject | undefined {
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
  } catch {
    return undefined
  }
}

export async function readWitness(witnessUrl: string): Promise<WitnessView> {
  const url = witnessUrl.replace(/\/+$/, '')
  const key = await getJson(`${url}/v1/key`)
  if (!isObject(key) || typeof key.origin !== 'string' || typeof key.public_key !== 'string') throw new Error(`the witness at ${url} publishes no key`)
  if (key.algorithm !== 'ed25519') throw new Error(`the witness at ${url} signs with ${String(key.algorithm)}, not ed25519`)
  const parsed = publicKeyOf(key.public_key)
  if (!parsed) throw new Error(`the witness at ${url} publishes a key that is not an Ed25519 key`)
  const latest = await getJson(`${url}/v1/checkpoints/latest`)
  if (latest !== undefined && !isCheckpoint(latest)) throw new Error(`the witness at ${url} answered something that is not a checkpoint`)
  return { origin: key.origin, publicKey: key.public_key, key: parsed, latest }
}

export async function readWitnessHistory(witnessUrl: string): Promise<WitnessedCheckpoint[]> {
  const url = witnessUrl.replace(/\/+$/, '')
  const history = await getJson(`${url}/v1/checkpoints`)
  if (!isObject(history) || !Array.isArray(history.data) || !history.data.every(isCheckpoint)) {
    throw new Error(`the witness at ${url} answered a history that is not a list of checkpoints`)
  }
  return history.data
}

function subtrees(size: number): [level: number, index: number][] {
  const found: [number, number][] = []
  let offset = 0
  for (let level = 52; level >= 0; level--) {
    const width = 2 ** level
    if (size - offset >= width) {
      found.push([level, offset / width])
      offset += width
    }
  }
  return found
}

function interior(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(Buffer.of(1)).update(left).update(right).digest()
}

async function rootAt(client: pg.ClientBase, size: number): Promise<{ root: string } | { missing: string }> {
  const needed = subtrees(size)
  const { rows } = await client.query<{ level: number; idx: string; hash: Buffer }>(
    `SELECT n.level, n.idx::text AS idx, n.hash FROM audit_nodes n
     JOIN unnest($1::smallint[], $2::bigint[]) AS w(level, idx) ON w.level = n.level AND w.idx = n.idx`,
    [needed.map(([level]) => level), needed.map(([, index]) => index)],
  )
  const nodes = new Map(rows.map((r) => [`${r.level}:${r.idx}`, r.hash]))
  const hashes: Buffer[] = []
  for (const [level, index] of needed) {
    const hash = nodes.get(`${level}:${index}`)
    if (!hash) return { missing: `${level}:${index}` }
    hashes.push(hash)
  }
  return { root: hashes.reduceRight((right, left) => interior(left, right)).toString('hex') }
}

async function rootProblem(client: pg.ClientBase, treeSize: number, checkpoint: WitnessedCheckpoint, claimed: string): Promise<string | undefined> {
  if (checkpoint.size > treeSize) return `${claimed} size ${checkpoint.size} but the log has only ${treeSize} leaves`
  const computed = await rootAt(client, checkpoint.size)
  if ('missing' in computed) return `the log has no subtree ${computed.missing}, which the root at size ${checkpoint.size} needs`
  if (computed.root !== checkpoint.root) return `the root at size ${checkpoint.size} is ${computed.root}, ${claimed} ${checkpoint.root}`
  return undefined
}

interface StoredCopy extends WitnessedCheckpoint {
  witnessKey: string
}

async function newestCopy(client: pg.ClientBase): Promise<StoredCopy | undefined> {
  const { rows } = await client.query<{ size: string; root: Buffer; signature: Buffer; witness_key: string }>(
    'SELECT size::text, root, signature, witness_key FROM audit_checkpoints ORDER BY size DESC LIMIT 1',
  )
  return rows.map((row) => ({
    size: Number(row.size),
    root: row.root.toString('hex'),
    signature: row.signature.toString('base64'),
    witnessKey: row.witness_key,
  }))[0]
}

type Signed = (checkpoint: WitnessedCheckpoint) => boolean

async function latestProblem(client: pg.ClientBase, treeSize: number, latest: WitnessedCheckpoint, signed: Signed): Promise<string | undefined> {
  if (!signed(latest)) return `the checkpoint at size ${latest.size} does not carry the witness's signature`
  return rootProblem(client, treeSize, latest, 'the witness signed')
}

async function copyProblem(client: pg.ClientBase, treeSize: number, copy: StoredCopy, witness: WitnessView, signed: Signed): Promise<string | undefined> {
  if (copy.witnessKey !== witness.publicKey) {
    return `the copy in audit_checkpoints at size ${copy.size} names the witness key ${copy.witnessKey}, the witness publishes ${witness.publicKey}`
  }
  const { latest } = witness
  if (copy.size === latest?.size && copy.root === latest.root && copy.signature === latest.signature) return undefined
  if (!signed(copy)) return `the copy in audit_checkpoints at size ${copy.size} does not carry the witness's signature`
  return rootProblem(client, treeSize, copy, 'audit_checkpoints holds')
}

export async function checkWitnessedIn(client: pg.ClientBase, witness: WitnessView, treeSize: number): Promise<Finding> {
  const signed: Signed = (checkpoint) =>
    verify(null, Buffer.from(`${witness.origin}\n${checkpoint.size}\n${checkpoint.root}\n`), witness.key, Buffer.from(checkpoint.signature, 'base64'))
  const copy = await newestCopy(client)
  const problems = [
    witness.latest && (await latestProblem(client, treeSize, witness.latest, signed)),
    copy && (await copyProblem(client, treeSize, copy, witness, signed)),
  ].filter((problem) => problem !== undefined)
  return { count: problems.length, examples: problems }
}
