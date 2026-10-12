interface Bucket {
  tokens: number
  at: number
}

const MAX_BUCKETS = 10_000

export class TokenBuckets {
  readonly #buckets = new Map<string, Bucket>()
  readonly #ratePerSecond: number
  readonly #burst: number
  readonly #now: () => number

  constructor(ratePerSecond: number, burst: number, now: () => number = () => performance.now()) {
    this.#ratePerSecond = ratePerSecond
    this.#burst = burst
    this.#now = now
  }

  take(key: string): boolean {
    const now = this.#now()
    const bucket = this.#buckets.get(key) ?? { tokens: this.#burst, at: now }
    bucket.tokens = Math.min(this.#burst, bucket.tokens + ((now - bucket.at) / 1000) * this.#ratePerSecond)
    bucket.at = now
    this.#buckets.delete(key)
    this.#buckets.set(key, bucket)
    if (this.#buckets.size > MAX_BUCKETS) this.#buckets.delete(this.#buckets.keys().next().value!)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }
}
