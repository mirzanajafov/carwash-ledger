import { Controller, Get, Param, Query } from '@nestjs/common'
import { ORIGIN, toHex } from '@carwash/audit'
import { Database } from '../db/database.ts'
import { badRequest, notFound } from '../http/api-error.ts'
import { runView, VerificationRuns } from './verification-runs.ts'
import { head, proveConsistency, proveInclusion, rootAt, treeSize } from '@carwash/audit-pg'

function size(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d{1,15}$/.test(value)) throw badRequest(`${name} must be a tree size`)
  return Number(value)
}

@Controller('v1')
export class AuditController {
  readonly #db: Database
  readonly #runs: VerificationRuns

  constructor(db: Database, runs: VerificationRuns) {
    this.#db = db
    this.#runs = runs
  }

  @Get('audit/verification')
  async verification() {
    const latest = await this.#runs.latest()
    if (!latest) throw notFound('a verification run')
    return runView(latest)
  }

  @Get('audit/head')
  async head() {
    const current = await head(this.#db.pool)
    return { object: 'audit_head', tree_size: current.size, root: toHex(current.root), chain: toHex(current.chain) }
  }

  @Get('audit/checkpoint')
  async checkpoint() {
    const { rows } = await this.#db.pool.query<{ size: string; root: Buffer; signature: Buffer; witness_key: string; signed_at: Date }>(
      'SELECT size::text, root, signature, witness_key, signed_at FROM audit_checkpoints c ORDER BY c.size DESC LIMIT 1',
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

  @Get('audit/checkpoints')
  async checkpoints() {
    const { rows } = await this.#db.pool.query<{ size: string; root: Buffer; signed_at: Date }>(
      'SELECT size::text, root, signed_at FROM audit_checkpoints c ORDER BY c.size DESC LIMIT 20',
    )
    return { object: 'list', data: rows.map((r) => ({ tree_size: Number(r.size), root: toHex(new Uint8Array(r.root)), signed_at: r.signed_at.toISOString() })) }
  }

  @Get('audit/leaves/:seq')
  async leaf(@Param('seq') seq: string) {
    const at = size(seq, 'seq')!
    const { rows } = await this.#db.pool.query<{ journal_id: string; leaf: Buffer }>('SELECT journal_id::text, leaf FROM audit_log WHERE seq = $1', [at])
    if (!rows[0]) throw notFound(`seq ${at} in the audit log`)
    return { object: 'leaf', seq: at, journal_id: rows[0].journal_id, leaf: toHex(new Uint8Array(rows[0].leaf)) }
  }

  @Get('journals/:id')
  async journal(@Param('id') id: string) {
    if (!/^\d{1,18}$/.test(id)) throw badRequest('the journal id must be a number')
    const { rows } = await this.#db.pool.query<{
      id: string
      external_ref: string
      micros: string
      created_at: Date
      seq: string | null
      entries: { id: string; account_id: string; account: string; amount: string }[]
    }>(
      `SELECT j.id::text, j.external_ref, (extract(epoch FROM j.created_at) * 1000000)::bigint::text AS micros, j.created_at,
              (SELECT a.seq::text FROM audit_log a WHERE a.journal_id = j.id) AS seq,
              json_agg(json_build_object('id', e.id::text, 'account_id', e.account_id::text, 'account', acc.code, 'amount', e.amount::text) ORDER BY e.id) AS entries
       FROM journals j JOIN entries e ON e.journal_id = j.id JOIN accounts acc ON acc.id = e.account_id
       WHERE j.id = $1 GROUP BY j.id`,
      [id],
    )
    const journal = rows[0]
    if (!journal) throw notFound(`journal ${id}`)
    return {
      object: 'journal',
      id: journal.id,
      external_ref: journal.external_ref,
      created_at: journal.created_at.toISOString(),
      created_at_micros: journal.micros,
      seq: journal.seq === null ? null : Number(journal.seq),
      entries: journal.entries,
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
