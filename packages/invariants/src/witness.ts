import { createHash, createPublicKey, verify } from 'node:crypto'
import type pg from 'pg'
import { EXAMPLES, type Finding } from './collect.ts'

export interface WitnessedCheckpoint {
  size: number
  root: string
  signature: string
}

export interface WitnessView {
  origin: string
  publicKey: string
  checkpoints: readonly WitnessedCheckpoint[]
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
  return response.json()
}

export async function readWitness(url: string): Promise<WitnessView> {
  const key = (await getJson(`${url}/v1/key`)) as { origin: string; algorithm: string; public_key: string }
  if (key.algorithm !== 'ed25519') throw new Error(`the witness signs with ${key.algorithm}, not ed25519`)
  const { data } = (await getJson(`${url}/v1/checkpoints`)) as { data: WitnessedCheckpoint[] }
  return { origin: key.origin, publicKey: key.public_key, checkpoints: data }
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

export async function checkWitnessedIn(client: pg.ClientBase, witness: WitnessView): Promise<Finding> {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: witness.publicKey }, format: 'jwk' })
  const { rows: sized } = await client.query<{ size: string }>('SELECT coalesce(max(seq) + 1, 0)::text AS size FROM audit_log')
  const treeSize = Number(sized[0]!.size)
  const details: string[] = []
  const covered: WitnessedCheckpoint[] = []
  for (const checkpoint of witness.checkpoints) {
    const body = Buffer.from(`${witness.origin}\n${checkpoint.size}\n${checkpoint.root}\n`)
    if (!verify(null, body, key, Buffer.from(checkpoint.signature, 'base64'))) {
      details.push(`the checkpoint at size ${checkpoint.size} does not carry the witness's signature`)
    } else if (checkpoint.size > treeSize) {
      details.push(`the witness signed size ${checkpoint.size} but the log has only ${treeSize} leaves`)
    } else {
      covered.push(checkpoint)
    }
  }
  const wanted = new Map<string, [number, number]>()
  for (const checkpoint of covered) for (const [level, index] of subtrees(checkpoint.size)) wanted.set(`${level}:${index}`, [level, index])
  const pairs = [...wanted.values()]
  const { rows } = await client.query<{ level: number; idx: string; hash: Buffer }>(
    `SELECT n.level, n.idx::text AS idx, n.hash FROM audit_nodes n
     JOIN unnest($1::smallint[], $2::bigint[]) AS w(level, idx) ON w.level = n.level AND w.idx = n.idx`,
    [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
  )
  const nodes = new Map(rows.map((r) => [`${r.level}:${r.idx}`, r.hash]))
  for (const checkpoint of covered) {
    const needed = subtrees(checkpoint.size)
    if (needed.length === 0) continue
    const missing = needed.find(([level, index]) => !nodes.has(`${level}:${index}`))
    if (missing) {
      details.push(`the log has no subtree ${missing[0]}:${missing[1]}, which the root at size ${checkpoint.size} needs`)
      continue
    }
    const hashes = needed.map(([level, index]) => nodes.get(`${level}:${index}`)!)
    let root = hashes.at(-1)!
    for (let k = hashes.length - 2; k >= 0; k--) root = interior(hashes[k]!, root)
    if (root.toString('hex') !== checkpoint.root) {
      details.push(`the root at size ${checkpoint.size} is ${root.toString('hex')}, the witness signed ${checkpoint.root}`)
    }
  }
  return { count: details.length, examples: details.slice(0, EXAMPLES) }
}
