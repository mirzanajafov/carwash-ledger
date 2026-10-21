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
  latest: WitnessedCheckpoint | undefined
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
  return response.json()
}

export async function readWitness(url: string): Promise<WitnessView> {
  const key = (await getJson(`${url}/v1/key`)) as { origin: string; algorithm: string; public_key: string } | undefined
  if (key?.algorithm !== 'ed25519') throw new Error(`the witness at ${url} publishes no ed25519 key`)
  const latest = (await getJson(`${url}/v1/checkpoints/latest`)) as WitnessedCheckpoint | undefined
  return { origin: key.origin, publicKey: key.public_key, latest }
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

interface Claim {
  checkpoint: WitnessedCheckpoint
  signed: boolean
  name: string
  claims: string
}

async function claimProblem(client: pg.ClientBase, treeSize: number, { checkpoint, signed, name, claims }: Claim): Promise<string | undefined> {
  if (!signed) return `${name} at size ${checkpoint.size} does not carry the witness's signature`
  if (checkpoint.size > treeSize) return `${claims} size ${checkpoint.size} but the log has only ${treeSize} leaves`
  const computed = await rootAt(client, checkpoint.size)
  if ('missing' in computed) return `the log has no subtree ${computed.missing}, which the root at size ${checkpoint.size} needs`
  if (computed.root !== checkpoint.root) return `the root at size ${checkpoint.size} is ${computed.root}, ${claims} ${checkpoint.root}`
  return undefined
}

async function newestCopy(client: pg.ClientBase): Promise<WitnessedCheckpoint | undefined> {
  const { rows } = await client.query<{ size: string; root: Buffer; signature: Buffer }>(
    'SELECT size::text, root, signature FROM audit_checkpoints ORDER BY size DESC LIMIT 1',
  )
  return rows.map((row) => ({ size: Number(row.size), root: row.root.toString('hex'), signature: row.signature.toString('base64') }))[0]
}

export async function checkWitnessedIn(client: pg.ClientBase, witness: WitnessView): Promise<Finding> {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: witness.publicKey }, format: 'jwk' })
  const signed = (checkpoint: WitnessedCheckpoint) =>
    verify(null, Buffer.from(`${witness.origin}\n${checkpoint.size}\n${checkpoint.root}\n`), key, Buffer.from(checkpoint.signature, 'base64'))
  const { rows } = await client.query<{ size: string }>('SELECT coalesce(max(seq) + 1, 0)::text AS size FROM audit_log')
  const treeSize = Number(rows[0]?.size ?? 0)
  const { latest } = witness
  const copy = await newestCopy(client)
  const claims: Claim[] = []
  if (latest) claims.push({ checkpoint: latest, signed: signed(latest), name: 'the checkpoint', claims: 'the witness signed' })
  if (copy && (copy.size !== latest?.size || copy.root !== latest.root || copy.signature !== latest.signature)) {
    claims.push({ checkpoint: copy, signed: signed(copy), name: 'the copy in audit_checkpoints', claims: 'audit_checkpoints holds' })
  }
  const problems: string[] = []
  for (const claim of claims) {
    const problem = await claimProblem(client, treeSize, claim)
    if (problem) problems.push(problem)
  }
  return { count: problems.length, examples: problems.slice(0, EXAMPLES) }
}
