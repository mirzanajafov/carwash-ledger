import { Controller, Get, Param, Query } from '@nestjs/common'
import { ORIGIN, toHex } from '@carwash/audit'
import { Database } from '../db/database.ts'
import { badRequest, notFound } from '../http/api-error.ts'
import { head, proveConsistency, proveInclusion, rootAt, treeSize } from './audit-log.ts'

function size(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d{1,15}$/.test(value)) throw badRequest(`${name} must be a tree size`)
  return Number(value)
}

@Controller('v1')
export class AuditController {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  @Get('audit/head')
  async head() {
    const current = await head(this.#db.pool)
    return { object: 'audit_head', tree_size: current.size, root: toHex(current.root), chain: toHex(current.chain) }
  }

  @Get('audit/checkpoint')
  async checkpoint() {
    const { rows } = await this.#db.pool.query<{ size: string; root: Buffer; signature: Buffer; witness_key: string; signed_at: Date }>(
      'SELECT size::text, root, signature, witness_key, signed_at FROM audit_checkpoints ORDER BY size DESC LIMIT 1',
    )
    const latest = rows[0]
    if (!latest) throw notFound('a witnessed checkpoint')
    return {
      object: 'audit_checkpoint',
      origin: ORIGIN,
      tree_size: Number(latest.size),
      root: toHex(new Uint8Array(latest.root)),
      signature: latest.signature.toString('base64'),
      witness_key: latest.witness_key,
      signed_at: latest.signed_at.toISOString(),
    }
  }

  @Get('journals/:id/proof')
  async inclusion(@Param('id') id: string, @Query('tree_size') requested?: string) {
    if (!/^\d{1,18}$/.test(id)) throw badRequest('the journal id must be a number')
    const { rows } = await this.#db.pool.query<{ seq: string; leaf: Buffer }>('SELECT seq::text, leaf FROM audit_log WHERE journal_id = $1', [id])
    if (!rows[0]) throw notFound(`a sequenced journal ${id}`)
    const seq = Number(rows[0].seq)
    const current = await treeSize(this.#db.pool)
    const at = size(requested, 'tree_size') ?? current
    if (at <= seq || at > current) throw badRequest(`tree_size must be between ${seq + 1} and ${current}`)
    const proof = await proveInclusion(this.#db.pool, seq, at)
    return {
      object: 'inclusion_proof',
      journal_id: id,
      seq,
      leaf: toHex(new Uint8Array(rows[0].leaf)),
      tree_size: at,
      root: toHex(await rootAt(this.#db.pool, at)),
      proof: proof.map(toHex),
    }
  }

  @Get('audit/consistency')
  async consistency(@Query('first') first?: string, @Query('second') second?: string) {
    const current = await treeSize(this.#db.pool)
    const from = size(first, 'first')
    const to = size(second, 'second') ?? current
    if (from === undefined || from < 1 || from > to || to > current) throw badRequest(`first and second must satisfy 1 <= first <= second <= ${current}`)
    return {
      object: 'consistency_proof',
      first: from,
      second: to,
      first_root: toHex(await rootAt(this.#db.pool, from)),
      second_root: toHex(await rootAt(this.#db.pool, to)),
      proof: (await proveConsistency(this.#db.pool, from, to)).map(toHex),
    }
  }
}
