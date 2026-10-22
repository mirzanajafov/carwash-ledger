import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { checkpointBody, Frontier, ORIGIN, toHex } from '@carwash/audit'
import type pg from 'pg'

export interface SignedCopies {
  origin: string
  publicKey: string
  key: KeyObject
  latest: { size: number; root: string; signature: string }
  count: number
}

export async function signCopies(db: pg.Pool | pg.ClientBase, size: number, leavesPerCheckpoint: number): Promise<SignedCopies> {
  const { privateKey } = generateKeyPairSync('ed25519')
  const publicKey = createPublicKey(privateKey)
  const { x } = publicKey.export({ format: 'jwk' })
  if (!x) throw new Error('an Ed25519 key exports its public half as x')
  const frontier = new Frontier()
  let next = 1
  let count = 0
  let latest: SignedCopies['latest'] | undefined
  for (let from = 0; from < size; from += 50_000) {
    const { rows } = await db.query<{ leaf: Buffer }>('SELECT a.leaf FROM audit_log a WHERE a.seq >= $1 AND a.seq < $2 ORDER BY a.seq', [from, from + 50_000])
    const copies: { size: number; root: Buffer; signature: Buffer }[] = []
    for (const row of rows) {
      frontier.push(new Uint8Array(row.leaf))
      if (frontier.size < Math.round(next * leavesPerCheckpoint) && frontier.size !== size) continue
      next++
      const root = toHex(frontier.root())
      const signature = sign(null, Buffer.from(checkpointBody({ size: frontier.size, root })), privateKey)
      copies.push({ size: frontier.size, root: Buffer.from(root, 'hex'), signature })
      latest = { size: frontier.size, root, signature: signature.toString('base64') }
    }
    const inserted = await db.query(
      `INSERT INTO audit_checkpoints (size, root, signature, witness_key, signed_at)
       SELECT size, root, signature, $4, now() FROM unnest($1::bigint[], $2::bytea[], $3::bytea[]) AS c(size, root, signature)
       ON CONFLICT (size) DO NOTHING`,
      [copies.map((c) => c.size), copies.map((c) => c.root), copies.map((c) => c.signature), x],
    )
    count += inserted.rowCount ?? 0
  }
  if (!latest) throw new Error('the audit log is empty')
  return { origin: ORIGIN, publicKey: x, key: publicKey, latest, count }
}
