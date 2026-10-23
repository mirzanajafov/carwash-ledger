import type { VerificationRunView } from '@carwash/contracts'
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
  checked: number
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
  checked: string
  size: string | null
  report: VerificationResult | null
  error: string | null
}

const COLUMNS = `r.id::text, r.status::text, r.requested_at, r.started_at, r.finished_at, r.attempts, r.checked::text, r.size::text, r.report, r.error`

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
    checked: Number(row.checked),
    size: row.size === null ? null : Number(row.size),
    report: row.report,
    error: row.error,
  }
}

export function runView(run: VerificationRun): VerificationRunView {
  return {
    object: 'verification_run',
    id: run.id,
    status: run.status,
    requested_at: run.requestedAt.toISOString(),
    started_at: run.startedAt?.toISOString() ?? null,
    finished_at: run.finishedAt?.toISOString() ?? null,
    attempts: run.attempts,
    progress: run.size === null ? null : { checked: run.checked, size: run.size },
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
    const { rows } = await this.#db.pool.query<Row>(
      `INSERT INTO verification_runs AS r DEFAULT VALUES ON CONFLICT ((true)) WHERE status IN ('queued', 'running') DO NOTHING RETURNING ${COLUMNS}`,
    )
    const run = rows.map(toRun)[0] ?? (await this.open()) ?? (await this.latest())
    if (!run) throw new Error('a verification run was requested but none exists')
    return run
  }

  async claim(): Promise<VerificationRun | undefined> {
    const { rows } = await this.#db.pool.query<Row>(
      `WITH exhausted AS (
         UPDATE verification_runs SET status = 'failed', finished_at = now(), locked_until = NULL,
                error = 'the worker stopped during this run ${ATTEMPTS} times'
         WHERE status = 'running' AND locked_until < now() AND attempts >= ${ATTEMPTS}
       )
       UPDATE verification_runs r SET status = 'running', started_at = now(), locked_until = now() + ${LEASE},
              attempts = r.attempts + 1, checked = 0, size = NULL
       WHERE r.id = (
         SELECT id FROM verification_runs
         WHERE status = 'queued' OR (status = 'running' AND locked_until < now() AND attempts < ${ATTEMPTS})
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING ${COLUMNS}`,
    )
    return rows.map(toRun)[0]
  }

  async progress(run: VerificationRun, checked: number, size: number): Promise<boolean> {
    const { rowCount } = await this.#db.pool.query(
      `UPDATE verification_runs SET checked = $3, size = $4, locked_until = now() + ${LEASE} WHERE id = $1 AND attempts = $2 AND status = 'running'`,
      [run.id, run.attempts, checked, size],
    )
    return rowCount === 1
  }

  async finish(run: VerificationRun, report: VerificationResult): Promise<boolean> {
    const { rowCount } = await this.#db.pool.query(
      `UPDATE verification_runs SET status = 'done', finished_at = now(), locked_until = NULL, checked = $4, size = $4, report = $3
       WHERE id = $1 AND attempts = $2 AND status = 'running'`,
      [run.id, run.attempts, JSON.stringify(report), report.size],
    )
    return rowCount === 1
  }

  async fail(run: VerificationRun, error: string): Promise<void> {
    await this.#db.pool.query(
      `UPDATE verification_runs SET status = 'failed', finished_at = now(), locked_until = NULL, error = $3
       WHERE id = $1 AND attempts = $2 AND status = 'running'`,
      [run.id, run.attempts, error],
    )
  }

  async retryOrFail(run: VerificationRun, error: string): Promise<void> {
    if (run.attempts >= ATTEMPTS) {
      await this.fail(run, error)
      return
    }
    await this.#db.pool.query(`UPDATE verification_runs SET status = 'queued', locked_until = NULL WHERE id = $1 AND attempts = $2 AND status = 'running'`, [
      run.id,
      run.attempts,
    ])
  }
}
