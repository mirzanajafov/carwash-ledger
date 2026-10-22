import { Controller, Get, Param, Query } from '@nestjs/common'
import { ORIGIN, toHex } from '@carwash/audit'
import { Database } from '../db/database.ts'
import { badRequest, notFound } from '../http/api-error.ts'
import { findJournal, latestCheckpoint, leafAt, leafOf, recentCheckpoints } from './audit.repository.ts'
import { runView, VerificationRuns } from './verification-runs.ts'
import { head, proveConsistency, proveInclusion, rootAt, treeSize } from '@carwash/audit-pg'

function size(value: string, name: string): number
function size(value: string | undefined, name: string): number | undefined
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
    const latest = await latestCheckpoint(this.#db.pool)
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
    const rows = await recentCheckpoints(this.#db.pool, 20)
    return { object: 'list', data: rows.map((r) => ({ tree_size: Number(r.size), root: toHex(new Uint8Array(r.root)), signed_at: r.signed_at.toISOString() })) }
  }

  @Get('audit/leaves/:seq')
  async leaf(@Param('seq') seq: string) {
    const at = size(seq, 'seq')
    const found = await leafAt(this.#db.pool, at)
    if (!found) throw notFound(`seq ${at} in the audit log`)
    return { object: 'leaf', seq: at, journal_id: found.journal_id, leaf: toHex(new Uint8Array(found.leaf)) }
  }

  @Get('journals/:id')
  async journal(@Param('id') id: string) {
    if (!/^\d{1,18}$/.test(id)) throw badRequest('the journal id must be a number')
    const journal = await findJournal(this.#db.pool, id)
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
    const sequenced = await leafOf(this.#db.pool, id)
    if (!sequenced) throw notFound(`a sequenced journal ${id}`)
    const seq = Number(sequenced.seq)
    const current = await treeSize(this.#db.pool)
    const at = size(requested, 'tree_size') ?? current
    if (at <= seq || at > current) throw badRequest(`tree_size must be between ${seq + 1} and ${current}`)
    const proof = await proveInclusion(this.#db.pool, seq, at)
    return {
      object: 'inclusion_proof',
      journal_id: id,
      seq,
      leaf: toHex(new Uint8Array(sequenced.leaf)),
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
