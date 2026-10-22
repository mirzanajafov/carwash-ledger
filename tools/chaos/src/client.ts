import type { EntrySpec, Outcome } from './messages.ts'
import type { Random } from './random.ts'

export interface Op {
  ref: string
  kind: 'capture' | 'reversal'
  entries: EntrySpec[]
  reversesRef?: string
  reversesId?: string | undefined
  journalId?: string
  acknowledged: boolean
  rejected?: string
  conflicts: string[]
  attempts: number
  inFlight: number
  retryAt?: number | undefined
  lastError?: string
}

export type Recorded = 'acknowledged' | 'retry' | 'rejected' | 'ignored'

export interface ClientStats {
  posted: number
  conflictRetries: number
  duplicates: number
  retryable: number
  rejected: number
}

export class ClientLedger {
  readonly ops = new Map<string, Op>()
  readonly stats: ClientStats = { posted: 0, conflictRetries: 0, duplicates: 0, retryable: 0, rejected: 0 }
  readonly #random: Random
  readonly #waiting = new Set<Op>()

  constructor(random: Random) {
    this.#random = random
  }

  add(op: Omit<Op, 'acknowledged' | 'conflicts' | 'attempts' | 'inFlight'>): Op {
    if (this.ops.has(op.ref)) throw new Error(`op ${op.ref} already exists`)
    const full: Op = { ...op, acknowledged: false, conflicts: [], attempts: 0, inFlight: 0 }
    this.ops.set(op.ref, full)
    if (full.retryAt !== undefined) this.#waiting.add(full)
    return full
  }

  dispatched(op: Op): void {
    op.attempts++
    op.inFlight++
    op.retryAt = undefined
    this.#waiting.delete(op)
  }

  defer(op: Op, at: number): void {
    op.retryAt = at
    this.#waiting.add(op)
  }

  record(ref: string, outcome: Outcome, now: number): Recorded {
    const op = this.ops.get(ref)
    if (op === undefined) throw new Error(`outcome for unknown op ${ref}`)
    op.inFlight = Math.max(0, op.inFlight - 1)
    switch (outcome.kind) {
      case 'posted':
      case 'duplicate': {
        if (outcome.kind === 'posted') {
          this.stats.posted++
          this.stats.conflictRetries += outcome.attempts - 1
        } else {
          this.stats.duplicates++
        }
        if (op.journalId !== undefined && op.journalId !== outcome.journalId) {
          op.conflicts.push(`${op.ref} was acknowledged as journal ${op.journalId} and then as ${outcome.journalId}`)
        }
        const first = !op.acknowledged
        op.acknowledged = true
        op.journalId ??= outcome.journalId
        op.retryAt = undefined
        this.#waiting.delete(op)
        return first ? 'acknowledged' : 'ignored'
      }
      case 'rejected':
        this.stats.rejected++
        if (op.acknowledged) return 'ignored'
        op.rejected = outcome.error
        return 'rejected'
      case 'retryable':
        this.stats.retryable++
        op.lastError = outcome.error
        if (op.acknowledged || op.rejected !== undefined || op.inFlight > 0) return 'ignored'
        op.retryAt = now + this.backoff(op.attempts)
        this.#waiting.add(op)
        return 'retry'
    }
  }

  backoff(attempts: number): number {
    const cap = Math.min(2000, 50 * 2 ** Math.min(attempts, 6))
    return Math.round(cap * (0.5 + this.#random() * 0.5))
  }

  due(now: number): Op[] {
    return [...this.#waiting].filter((op) => op.retryAt !== undefined && op.retryAt <= now)
  }

  unresolved(): Op[] {
    return [...this.ops.values()].filter((op) => !op.acknowledged && op.rejected === undefined)
  }

  inFlight(): number {
    let total = 0
    for (const op of this.ops.values()) total += op.inFlight
    return total
  }
}
