import { Injectable } from '@nestjs/common'
import type { VerifyReport } from '@carwash/audit-pg'
import { Database } from '../db/database.ts'

export type VerificationStatus = 'queued' | 'running' | 'done' | 'failed'

export type VerificationResult = Omit<VerifyReport, 'state'> & { root: string | null }

export interface VerificationRun {
  id: string
  status: VerificationStatus
  requestedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  attempts: number
  done: number
  size: number | null
  report: VerificationResult | null
  error: string | null
}

interface Row {
  id: string
  status: VerificationStatus
  requested_at: Date
  started_at: Date | null
  finished_at: Date | null
  attempts: number
  done: string
  size: string | null
  report: VerificationResult | null
  error: string | null
}

const COLUMNS = `r.id::text, r.status::text, r.requested_at, r.started_at, r.finished_at, r.attempts, r.done::text, r.size::text, r.report, r.error`

const LEASE = "interval '60 seconds'"
const ATTEMPTS = 3

function toRun(row: Row): VerificationRun {
  return {
    id: row.id,
    status: row.status,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    attempts: row.attempts,
    done: Number(row.done),
    size: row.size === null ? null : Number(row.size),
    report: row.report,
    error: row.error,
  }
}

export function runView(run: VerificationRun) {
  return {
    object: 'verification_run',
    id: run.id,
    status: run.status,
    requested_at: run.requestedAt.toISOString(),
    started_at: run.startedAt?.toISOString() ?? null,
    finished_at: run.finishedAt?.toISOString() ?? null,
    attempts: run.attempts,
    progress: run.size === null ? null : { done: run.done, size: run.size },
    report: run.report,
    error: run.error,
  }
}

@Injectable()
export class VerificationRuns {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  async open(): Promise<VerificationRun | undefined> {
    const { rows } = await this.#db.pool.query<Row>(`SELECT ${COLUMNS} FROM verification_runs r WHERE r.status IN ('queued', 'running')`)
    return rows.map(toRun)[0]
  }

  async latest(): Promise<VerificationRun | undefined> {
    const { rows } = await this.#db.pool.query<Row>(`SELECT ${COLUMNS} FROM verification_runs r ORDER BY r.id DESC LIMIT 1`)
    return rows.map(toRun)[0]
  }

  async request(): Promise<VerificationRun> {
    await this.#db.pool.query(`DELETE FROM verification_runs WHERE status IN ('done', 'failed') AND requested_at < now() - interval '1 day'`)
    await this.#db.pool.query(`INSERT INTO verification_runs DEFAULT VALUES ON CONFLICT ((true)) WHERE status IN ('queued', 'running') DO NOTHING`)
    const open = await this.open()
    if (!open) throw new Error('a verification run was requested but none is open')
    return open
  }

  async claim(): Promise<VerificationRun | undefined> {
    await this.#db.pool.query(
      `UPDATE verification_runs SET status = 'failed', finished_at = now(), locked_until = NULL,
              error = 'the worker stopped during this run ${ATTEMPTS} times'
       WHERE status = 'running' AND locked_until < now() AND attempts >= ${ATTEMPTS}`,
    )
    const { rows } = await this.#db.pool.query<Row>(
      `UPDATE verification_runs r SET status = 'running', started_at = now(), locked_until = now() + ${LEASE},
              attempts = r.attempts + 1, done = 0, size = NULL
       WHERE r.id = (
         SELECT id FROM verification_runs
         WHERE status = 'queued' OR (status = 'running' AND locked_until < now())
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING ${COLUMNS}`,
    )
    return rows.map(toRun)[0]
  }

  async progress(id: string, done: number, size: number): Promise<void> {
    await this.#db.pool.query(`UPDATE verification_runs SET done = $2, size = $3, locked_until = now() + ${LEASE} WHERE id = $1 AND status = 'running'`, [
      id,
      done,
      size,
    ])
  }

  async finish(id: string, report: VerificationResult): Promise<void> {
    await this.#db.pool.query(
      `UPDATE verification_runs SET status = 'done', finished_at = now(), locked_until = NULL, done = $3, size = $3, report = $2
       WHERE id = $1 AND status = 'running'`,
      [id, JSON.stringify(report), report.size],
    )
  }

  async fail(id: string, error: string): Promise<void> {
    await this.#db.pool.query(
      `UPDATE verification_runs SET status = 'failed', finished_at = now(), locked_until = NULL, error = $2 WHERE id = $1 AND status = 'running'`,
      [id, error],
    )
  }
}
