import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { errorOf } from '@carwash/contracts'
import type { Random } from '../random.ts'

export type RequestKind = 'create' | 'capture' | 'cancel' | 'refund' | 'payout' | 'merchant' | 'probe'

export type Verdict = 'stored' | 'refused' | 'rejected' | 'retry'

export interface Answer {
  status: number
  body: unknown
  verdict: Verdict
  retryAfter: number
}

export interface RequestRecord {
  key: string
  caller: string
  kind: RequestKind
  path: string
  body: Record<string, unknown>
  sends: number
  final?: Answer
  stored: string[]
  lastError?: string
}

export interface ClientStats {
  requests: number
  sends: number
  duplicates: number
  answers: Record<string, number>
}

export interface Endpoints {
  live(): string[]
}

export function verdictOf(status: number, body: unknown): Verdict {
  if (status === 200 || status === 402) return 'stored'
  if (status === 502) return 'refused'
  if (status >= 500 || status === 429) return 'retry'
  if (status === 409 && errorOf(body)?.code === 'request_in_progress') return 'retry'
  return 'rejected'
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function backoff(random: Random, attempts: number, retryAfterSeconds = 0): number {
  const cap = Math.min(2000, 50 * 2 ** Math.min(attempts, 6))
  return Math.max(Math.round(cap * (0.5 + random() * 0.5)), retryAfterSeconds * 1000)
}

export class Clients {
  readonly records = new Map<string, RequestRecord>()
  readonly probes: RequestRecord[] = []
  readonly stats: ClientStats = { requests: 0, sends: 0, duplicates: 0, answers: {} }
  readonly inFlight = new Map<string, number>()
  readonly #endpoints: Endpoints
  readonly #keys: Readonly<Record<string, string>>
  readonly #random: Random
  readonly #timeoutMs: number
  readonly #log: (line: string) => void
  #stopped = false
  #logged = 0

  constructor(endpoints: Endpoints, keys: Readonly<Record<string, string>>, random: Random, log: (line: string) => void, timeoutMs = 10_000) {
    this.#endpoints = endpoints
    this.#keys = keys
    this.#random = random
    this.#log = log
    this.#timeoutMs = timeoutMs
  }

  stop(): void {
    this.#stopped = true
  }

  unanswered(): number {
    let open = 0
    for (const record of [...this.records.values(), ...this.probes]) if (record.final === undefined) open++
    return open
  }

  record(caller: string, kind: RequestKind, path: string, body: Record<string, unknown>, key: string = randomUUID()): RequestRecord {
    const record: RequestRecord = { key, caller, kind, path, body, sends: 0, stored: [] }
    if (kind === 'probe') this.probes.push(record)
    else if (this.records.has(key)) throw new Error(`key ${key} was already used`)
    else this.records.set(key, record)
    this.stats.requests++
    return record
  }

  async send(record: RequestRecord, duplicate = false): Promise<Answer | undefined> {
    for (let round = 0; ; round++) {
      if (this.#stopped) return undefined
      const live = this.#endpoints.live()
      if (live.length === 0) {
        await sleep(50)
        continue
      }
      const first = Math.floor(this.#random() * live.length)
      const rotated = [...live.slice(first), ...live.slice(0, first)]
      const targets = rotated.slice(0, duplicate && record.sends === 0 ? 2 : 1)
      if (targets.length === 2) this.stats.duplicates++
      const answers = await Promise.all(targets.map((url) => this.#once(record, url)))
      const final = answers.find((a) => a.verdict === 'stored') ?? answers.find((a) => a.verdict !== 'retry')
      if (final !== undefined) {
        record.final = final
        return final
      }
      const retryAfter = Math.max(0, ...answers.map((a) => a.retryAfter))
      await sleep(backoff(this.#random, round, retryAfter))
    }
  }

  async #once(record: RequestRecord, base: string): Promise<Answer> {
    const key = this.#keys[record.caller]
    if (key === undefined) throw new Error(`there is no key for ${record.caller}`)
    record.sends++
    this.stats.sends++
    this.inFlight.set(base, (this.inFlight.get(base) ?? 0) + 1)
    try {
      const response = await fetch(`${base}${record.path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'idempotency-key': record.key,
        },
        body: JSON.stringify(record.body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
      const text = await response.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = { unparsed: text.slice(0, 200) }
      }
      const verdict = verdictOf(response.status, body)
      const code = errorOf(body)?.code
      const label = `${response.status}${code ? ` ${code}` : ''}`
      this.#count(label)
      if (verdict === 'stored') record.stored.push(`${response.status} ${canonical(body)}`)
      if (verdict === 'retry') record.lastError = label
      const retryAfter = Number(response.headers.get('retry-after') ?? 0)
      return { status: response.status, body, verdict, retryAfter: verdict === 'retry' ? retryAfter : 0 }
    } catch (error) {
      const label = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error'
      this.#count(label)
      record.lastError = `${label}: ${error instanceof Error ? error.message : String(error)}`
      if (this.#logged++ % 50 === 0) this.#log(`client ${label} on ${base}${record.path} (${record.lastError})`)
      return { status: 0, body: null, verdict: 'retry', retryAfter: 0 }
    } finally {
      this.inFlight.set(base, (this.inFlight.get(base) ?? 0) - 1)
    }
  }

  #count(label: string): void {
    this.stats.answers[label] = (this.stats.answers[label] ?? 0) + 1
  }
}
