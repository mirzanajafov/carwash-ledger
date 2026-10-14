export interface Rule {
  perSecond: number
  burst: number
}

export const RULES = {
  heavy: { perSecond: 0.2, burst: 3 },
  api: { perSecond: 10, burst: 30 },
} satisfies Record<string, Rule>

const HEAVY = ['/api/plug', '/api/checks', '/api/audit/verify', '/api/audit/tamper', '/api/audit/restore', '/api/weather', '/api/admin/session']

export function ruleFor(method: string, path: string): keyof typeof RULES | null {
  if (!path.startsWith('/api/')) return null
  if (method === 'POST' && HEAVY.includes(path)) return 'heavy'
  return 'api'
}

interface Bucket {
  tokens: number
  at: number
}

export class Buckets {
  readonly #buckets = new Map<string, Bucket>()
  readonly #idleMs: number
  #swept = 0

  constructor(idleMs = 10 * 60_000) {
    this.#idleMs = idleMs
  }

  take(key: string, rule: Rule, now: number): number {
    this.#sweep(now)
    const bucket = this.#buckets.get(key) ?? { tokens: rule.burst, at: now }
    bucket.tokens = Math.min(rule.burst, bucket.tokens + ((now - bucket.at) / 1000) * rule.perSecond)
    bucket.at = now
    this.#buckets.set(key, bucket)
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return 0
    }
    return Math.ceil((1 - bucket.tokens) / rule.perSecond)
  }

  get size(): number {
    return this.#buckets.size
  }

  #sweep(now: number): void {
    if (now - this.#swept < this.#idleMs) return
    this.#swept = now
    for (const [key, bucket] of this.#buckets) if (now - bucket.at > this.#idleMs) this.#buckets.delete(key)
  }
}

export function sameOrigin(method: string, origin: string | null, host: string | null): boolean {
  if (method === 'GET' || method === 'HEAD' || origin === null) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function clientIp(forwardedFor: string | null, fallback = 'unknown'): string {
  const first = forwardedFor?.split(',')[0]?.trim()
  return first || fallback
}

export class Streams {
  readonly #open = new Map<string, number>()
  readonly #max: number

  constructor(max: number) {
    this.#max = max
  }

  open(ip: string): (() => void) | null {
    const count = this.#open.get(ip) ?? 0
    if (count >= this.#max) return null
    this.#open.set(ip, count + 1)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      const left = (this.#open.get(ip) ?? 1) - 1
      if (left <= 0) this.#open.delete(ip)
      else this.#open.set(ip, left)
    }
  }
}
