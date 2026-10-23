import { restore, tamper, type TamperClass, type Tampered } from '@carwash/audit-pg'
import type { TamperView } from '@carwash/contracts'
import { Failures, pause } from '@carwash/jobs'
import { firstRow, withTransaction, type Queryable, type Transaction } from '@carwash/pg'
import type pg from 'pg'

const CHECK_EVERY_MS = 5000

export class Conflict extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

type Undo = Tampered & { witnessedSize: number; at: Date }

interface UndoRow {
  tamper_class: TamperClass
  seq: string
  journal_id: string
  witnessed_size: string
  undo: Tampered['undo']
  at: Date
}

const SELECT_UNDO = 'SELECT tamper_class, seq::text, journal_id::text, witnessed_size::text, undo, at FROM tamper_undo'

function fromRow(row: UndoRow | undefined): Undo | undefined {
  if (!row) return undefined
  return {
    tamperClass: row.tamper_class,
    seq: Number(row.seq),
    journalId: row.journal_id,
    undo: row.undo,
    witnessedSize: Number(row.witnessed_size),
    at: row.at,
  }
}

async function currentUndo(db: Queryable): Promise<Undo | undefined> {
  return fromRow((await db.query<UndoRow>(SELECT_UNDO)).rows[0])
}

async function lockCurrentUndo(client: Transaction): Promise<Undo | undefined> {
  return fromRow((await client.query<UndoRow>(`${SELECT_UNDO} FOR UPDATE`)).rows[0])
}

async function lockDueUndo(client: Transaction, afterMs: number): Promise<Undo | undefined> {
  return fromRow((await client.query<UndoRow>(`${SELECT_UNDO} WHERE at <= now() - make_interval(secs => $1) FOR UPDATE`, [afterMs / 1000])).rows[0])
}

async function msUntilDue(db: Queryable, afterMs: number): Promise<number | undefined> {
  const { rows } = await db.query<{ in_ms: number }>(
    'SELECT greatest(0, ceil(extract(epoch FROM at + make_interval(secs => $1) - now()) * 1000))::int AS in_ms FROM tamper_undo',
    [afterMs / 1000],
  )
  return rows[0]?.in_ms
}

export class TamperService {
  readonly #pool: pg.Pool
  readonly #random: () => number
  readonly #autoRestoreMs: number
  #queue: Promise<unknown> = Promise.resolve()

  constructor(pool: pg.Pool, options: { random?: () => number; autoRestoreMs?: number } = {}) {
    this.#pool = pool
    this.#random = options.random ?? Math.random
    this.#autoRestoreMs = options.autoRestoreMs ?? 0
  }

  async current(): Promise<TamperView | null> {
    const current = await currentUndo(this.#pool)
    return current ? this.#view(current) : null
  }

  tamper(tamperClass: TamperClass): Promise<TamperView> {
    return this.#serial(async () => this.#view(await withTransaction(this.#pool, (client) => this.#tamper(client, tamperClass))))
  }

  restore(): Promise<TamperView> {
    return this.#serial(async () => {
      const restored = await this.#restore(lockCurrentUndo)
      if (!restored) throw new Conflict('nothing_to_restore', 'nothing is tampered with')
      return this.#view(restored)
    })
  }

  async restoreWhenDue(signal: AbortSignal): Promise<void> {
    if (this.#autoRestoreMs <= 0) return
    const failures = new Failures('tamper: the automatic restore failed', (message) => process.stderr.write(`${message}\n`), 50)
    while (!signal.aborted) {
      let waitMs = CHECK_EVERY_MS
      try {
        const dueInMs = await msUntilDue(this.#pool, this.#autoRestoreMs)
        if (dueInMs === 0) await this.#serial(() => this.#restore((client) => lockDueUndo(client, this.#autoRestoreMs)))
        else if (dueInMs !== undefined) waitMs = Math.min(dueInMs, CHECK_EVERY_MS)
        failures.clear()
      } catch (error) {
        failures.record(error)
      }
      await pause(waitMs, signal)
    }
  }

  async #tamper(client: Transaction, tamperClass: TamperClass): Promise<Undo> {
    await client.query('LOCK TABLE tamper_undo IN SHARE ROW EXCLUSIVE MODE')
    const current = await currentUndo(client)
    if (current) throw new Conflict('already_tampered', `journal ${current.journalId} is tampered with already, so restore it first`)
    const witnessedSize = Number(firstRow(await client.query<{ size: string | null }>('SELECT max(size)::text AS size FROM audit_checkpoints')).size ?? 0)
    if (witnessedSize === 0) throw new Conflict('nothing_witnessed', 'the witness has not signed a checkpoint yet')
    const changed = await tamper(client, tamperClass, Math.floor(this.#random() * witnessedSize))
    const { at } = firstRow(
      await client.query<{ at: Date }>(
        `INSERT INTO tamper_undo (journal_id, tamper_class, seq, witnessed_size, undo, at) VALUES ($1, $2, $3, $4, $5, clock_timestamp()) RETURNING at`,
        [changed.journalId, changed.tamperClass, changed.seq, witnessedSize, JSON.stringify(changed.undo)],
      ),
    )
    return { ...changed, witnessedSize, at }
  }

  #restore(lock: (client: Transaction) => Promise<Undo | undefined>): Promise<Undo | undefined> {
    return withTransaction(this.#pool, async (client) => {
      const current = await lock(client)
      if (!current) return undefined
      await restore(client, current)
      await client.query('DELETE FROM tamper_undo WHERE journal_id = $1', [current.journalId])
      return current
    })
  }

  #view(current: Undo): TamperView {
    return {
      tamper_class: current.tamperClass,
      seq: current.seq,
      journal_id: current.journalId,
      witnessed_size: current.witnessedSize,
      at: current.at.toISOString(),
      restores_at: this.#autoRestoreMs > 0 ? new Date(current.at.getTime() + this.#autoRestoreMs).toISOString() : null,
    }
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work)
    this.#queue = result.catch(() => undefined)
    return result
  }
}
