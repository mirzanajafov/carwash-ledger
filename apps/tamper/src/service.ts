import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { restore, tamper, type TamperClass, type Tampered } from '@carwash/audit-pg'
import { checkout } from '@carwash/pg'
import type pg from 'pg'

export class Conflict extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface Tamper {
  tamper_class: TamperClass
  seq: number
  journal_id: string
  witnessed_size: number
  at: string
}

export class TamperService {
  readonly #pool: pg.Pool
  readonly #file: string
  readonly #random: () => number
  #current: (Tampered & { witnessedSize: number; at: string }) | undefined
  #queue: Promise<unknown> = Promise.resolve()

  constructor(pool: pg.Pool, dir: string, random: () => number = Math.random) {
    this.#pool = pool
    this.#random = random
    mkdirSync(dir, { recursive: true })
    this.#file = join(dir, 'tamper.json')
    if (existsSync(this.#file)) this.#current = JSON.parse(readFileSync(this.#file, 'utf8'))
  }

  current(): Tamper | null {
    const current = this.#current
    if (!current) return null
    return { tamper_class: current.tamperClass, seq: current.seq, journal_id: current.journalId, witnessed_size: current.witnessedSize, at: current.at }
  }

  tamper(tamperClass: TamperClass): Promise<Tamper> {
    return this.#serial(async () => {
      if (this.#current) throw new Conflict('already_tampered', `journal ${this.#current.journalId} is tampered with already; restore it first`)
      const { rows } = await this.#pool.query<{ size: string | null }>('SELECT max(size)::text AS size FROM audit_checkpoints')
      const witnessedSize = Number(rows[0]!.size ?? 0)
      if (witnessedSize === 0) throw new Conflict('nothing_witnessed', 'the witness has not signed a checkpoint yet')
      const seq = Math.floor(this.#random() * witnessedSize)
      const done = await this.#transaction((client) => tamper(client, tamperClass, seq))
      this.#save({ ...done, witnessedSize, at: new Date().toISOString() })
      return this.current()!
    })
  }

  restore(): Promise<Tamper> {
    return this.#serial(async () => {
      const current = this.#current
      if (!current) throw new Conflict('nothing_to_restore', 'nothing is tampered with')
      await this.#transaction((client) => restore(client, current))
      const restored = this.current()!
      this.#save(undefined)
      return restored
    })
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work)
    this.#queue = result.catch(() => undefined)
    return result
  }

  async #transaction<T>(work: (client: pg.ClientBase) => Promise<T>): Promise<T> {
    const lease = await checkout(this.#pool)
    let broken = false
    try {
      await lease.client.query('BEGIN')
      const value = await work(lease.client)
      await lease.client.query('COMMIT')
      return value
    } catch (error) {
      await lease.client.query('ROLLBACK').catch(() => {
        broken = true
      })
      throw error
    } finally {
      lease.release(broken)
    }
  }

  #save(current: (Tampered & { witnessedSize: number; at: string }) | undefined): void {
    if (current) {
      writeFileSync(`${this.#file}.next`, JSON.stringify(current), { mode: 0o600 })
      renameSync(`${this.#file}.next`, this.#file)
    } else {
      rmSync(this.#file, { force: true })
    }
    this.#current = current
  }
}
