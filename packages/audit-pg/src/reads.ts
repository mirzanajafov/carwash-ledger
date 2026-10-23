import type { Queryable } from '@carwash/pg'
import { MICROS } from './journals.ts'

export interface CheckpointRow {
  size: string
  root: Buffer
  signed_at: Date
}

export interface SignedCheckpointRow extends CheckpointRow {
  signature: Buffer
  witness_key: string
}

export interface JournalWithEntries {
  id: string
  external_ref: string
  micros: string
  created_at: Date
  seq: string | null
  entries: { id: string; account_id: string; account: string; amount: string }[]
}

export async function latestCheckpoint(db: Queryable): Promise<SignedCheckpointRow | undefined> {
  const { rows } = await db.query<SignedCheckpointRow>(
    'SELECT size::text, root, signature, witness_key, signed_at FROM audit_checkpoints c ORDER BY c.size DESC LIMIT 1',
  )
  return rows[0]
}

export async function recentCheckpoints(db: Queryable): Promise<CheckpointRow[]> {
  const { rows } = await db.query<CheckpointRow>('SELECT size::text, root, signed_at FROM audit_checkpoints c ORDER BY c.size DESC LIMIT 20')
  return rows
}

export async function leafBySeq(db: Queryable, seq: number): Promise<{ journal_id: string; leaf: Buffer } | undefined> {
  const { rows } = await db.query<{ journal_id: string; leaf: Buffer }>('SELECT journal_id::text, leaf FROM audit_log WHERE seq = $1', [seq])
  return rows[0]
}

export async function leafByJournal(db: Queryable, journalId: string): Promise<{ seq: string; leaf: Buffer } | undefined> {
  const { rows } = await db.query<{ seq: string; leaf: Buffer }>('SELECT seq::text, leaf FROM audit_log WHERE journal_id = $1', [journalId])
  return rows[0]
}

export async function findJournal(db: Queryable, id: string): Promise<JournalWithEntries | undefined> {
  const { rows } = await db.query<JournalWithEntries>(
    `SELECT j.id::text, j.external_ref, ${MICROS} AS micros, j.created_at,
            (SELECT a.seq::text FROM audit_log a WHERE a.journal_id = j.id) AS seq,
            json_agg(json_build_object('id', e.id::text, 'account_id', e.account_id::text, 'account', acc.code, 'amount', e.amount::text) ORDER BY e.id) AS entries
     FROM journals j JOIN entries e ON e.journal_id = j.id JOIN accounts acc ON acc.id = e.account_id
     WHERE j.id = $1 GROUP BY j.id`,
    [id],
  )
  return rows[0]
}
