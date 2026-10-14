import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import { readAllBalances } from '@carwash/ledger'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'

export type LiveEvent =
  | { type: 'balances'; data: { code: string; type: string; currency: string; amount: string }[] }
  | { type: 'journal'; data: { id: string; external_ref: string; posted_at: string; entries: { account: string; amount: string }[] } }
  | { type: 'payment'; data: { id: string; merchant: string; amount: string; currency: string; status: string; captured_amount: string; refunded_amount: string; updated_at: string } }

type Listener = (event: LiveEvent) => void

const LOOK_BACK = 1000n

const JOURNALS = `
  SELECT j.id::text, j.external_ref, j.created_at AS posted_at,
         json_agg(json_build_object('account', a.code, 'amount', e.amount::text) ORDER BY e.id) AS entries
  FROM journals j
  JOIN entries e ON e.journal_id = j.id
  JOIN accounts a ON a.id = e.account_id
  WHERE j.id > $1
  GROUP BY j.id
  ORDER BY j.id
  LIMIT 500`

const PAYMENTS = `
  SELECT p.id::text, m.code AS merchant, p.amount::text, p.currency, p.status::text,
         p.captured_amount::text, p.refunded_amount::text, p.updated_at
  FROM payments p
  JOIN merchants m ON m.id = p.merchant_id
  WHERE p.id >= uuidv7(interval '-60 seconds')
  ORDER BY p.id`

@Injectable()
export class LiveFeed implements OnModuleDestroy {
  readonly #db: Database
  readonly #config: ApiConfig
  readonly #logger = new Logger('live')
  readonly #listeners = new Set<Listener>()
  readonly #seen = new Set<bigint>()
  readonly #payments = new Map<string, string>()
  #cursor: bigint | undefined
  #balances = ''
  #last: LiveEvent | undefined
  #timer: NodeJS.Timeout | undefined
  #polling = false
  #failures = 0

  constructor(db: Database, @Inject(API_CONFIG) config: ApiConfig) {
    this.#db = db
    this.#config = config
  }

  get listeners(): number {
    return this.#listeners.size
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    if (this.#last) listener(this.#last)
    if (!this.#timer) {
      this.#timer = setInterval(() => void this.#poll(), this.#config.liveEveryMs)
      void this.#poll()
    }
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0) this.#stop()
    }
  }

  onModuleDestroy(): void {
    this.#listeners.clear()
    this.#stop()
  }

  #stop(): void {
    clearInterval(this.#timer)
    this.#timer = undefined
    this.#cursor = undefined
    this.#seen.clear()
    this.#payments.clear()
    this.#balances = ''
    this.#last = undefined
  }

  #emit(event: LiveEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  async #poll(): Promise<void> {
    if (this.#polling) return
    this.#polling = true
    try {
      const pool = this.#db.pool
      const balances = (await readAllBalances(pool)).map((b) => ({ ...b, amount: b.amount.toString() }))
      const key = JSON.stringify(balances)
      if (key !== this.#balances) {
        this.#balances = key
        this.#last = { type: 'balances', data: balances }
        this.#emit(this.#last)
      }
      if (this.#cursor === undefined) {
        const { rows } = await pool.query<{ id: string }>('SELECT coalesce(max(id), 0)::text AS id FROM journals')
        this.#cursor = BigInt(rows[0]!.id)
      } else {
        const from = this.#cursor > LOOK_BACK ? this.#cursor - LOOK_BACK : 0n
        const { rows } = await pool.query<{ id: string; external_ref: string; posted_at: Date; entries: { account: string; amount: string }[] }>(JOURNALS, [from.toString()])
        for (const row of rows) {
          const id = BigInt(row.id)
          if (id <= this.#cursor - LOOK_BACK || this.#seen.has(id)) continue
          this.#seen.add(id)
          if (id > this.#cursor) this.#cursor = id
          this.#emit({ type: 'journal', data: { ...row, posted_at: row.posted_at.toISOString() } })
        }
        for (const id of this.#seen) if (id <= this.#cursor - LOOK_BACK) this.#seen.delete(id)
      }
      const { rows: payments } = await pool.query<{ id: string; merchant: string; amount: string; currency: string; status: string; captured_amount: string; refunded_amount: string; updated_at: Date }>(PAYMENTS)
      const current = new Set<string>()
      for (const row of payments) {
        current.add(row.id)
        const version = `${row.status}:${row.updated_at.toISOString()}`
        if (this.#payments.get(row.id) === version) continue
        this.#payments.set(row.id, version)
        this.#emit({ type: 'payment', data: { ...row, updated_at: row.updated_at.toISOString() } })
      }
      for (const id of this.#payments.keys()) if (!current.has(id)) this.#payments.delete(id)
      this.#failures = 0
    } catch (error) {
      this.#failures++
      if (this.#failures === 1 || this.#failures % 60 === 0) this.#logger.warn(`the live poll failed: ${(error as Error).message}`)
    } finally {
      this.#polling = false
    }
  }
}
