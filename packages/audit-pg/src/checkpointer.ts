import type { KeyObject } from 'node:crypto'
import { fromHex, ORIGIN, toHex } from '@carwash/audit'
import { failpoint } from '@carwash/failpoints'
import type pg from 'pg'
import { proveConsistency, rootAt, treeSize } from './log.ts'
import type { WitnessClient } from './witness-client.ts'
import { isSignedBy, witnessKey } from './witness-key.ts'

export type CheckpointOutcome =
  | { kind: 'empty' }
  | { kind: 'signed'; size: number; fresh: boolean }
  | { kind: 'behind'; size: number; witnessed: number }
  | { kind: 'refused'; size: number; code: string; message: string }

export class Checkpointer {
  readonly #pool: pg.Pool
  readonly #witness: WitnessClient
  #key: { raw: string; object: KeyObject } | undefined

  constructor(pool: pg.Pool, witness: WitnessClient) {
    this.#pool = pool
    this.#witness = witness
  }

  async run(): Promise<CheckpointOutcome> {
    const key = await this.#witnessKey()
    const size = await treeSize(this.#pool)
    if (size === 0) return { kind: 'empty' }
    const latest = await this.#witness.latest()
    const from = latest?.size ?? 0
    if (from > size) return { kind: 'behind', size, witnessed: from }
    const root = toHex(await rootAt(this.#pool, size))
    const proof = from > 0 && from < size ? (await proveConsistency(this.#pool, from, size)).map(toHex) : []
    const reply = await this.#witness.submit({ size, root, from_size: from, proof })
    if (reply.kind === 'refused') return { kind: 'refused', size, code: reply.code, message: reply.message }
    const signed = reply.checkpoint
    if (signed.size !== size || signed.root !== root || !isSignedBy(signed, key.object)) {
      throw new Error(`the witness answered size ${size} with a checkpoint that does not verify`)
    }
    failpoint('checkpoint.after_sign')
    await this.#pool.query(
      `INSERT INTO audit_checkpoints (size, root, signature, witness_key, signed_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (size) DO NOTHING`,
      [size, Buffer.from(fromHex(root)), Buffer.from(signed.signature, 'base64'), key.raw, signed.signed_at],
    )
    return { kind: 'signed', size, fresh: reply.fresh }
  }

  async #witnessKey(): Promise<{ raw: string; object: KeyObject }> {
    if (this.#key) return this.#key
    const key = await this.#witness.key()
    if (key.origin !== ORIGIN) throw new Error(`the witness signs for ${key.origin}, not ${ORIGIN}`)
    if (key.algorithm !== 'ed25519') throw new Error(`the witness signs with ${key.algorithm}, not ed25519`)
    this.#key = { raw: key.public_key, object: witnessKey(key.public_key) }
    return this.#key
  }
}
