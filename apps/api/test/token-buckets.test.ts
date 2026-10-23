import { describe, expect, it } from 'vitest'
import { TokenBuckets } from '../src/auth/token-buckets.ts'

describe('the rate limit per key', () => {
  it('allows a burst, then the rate, per key', () => {
    let now = 0
    const buckets = new TokenBuckets(10, 20, () => now)
    expect(Array.from({ length: 25 }, () => buckets.take('a')).filter(Boolean)).toHaveLength(20)
    expect(buckets.take('b')).toBe(true)
    now = 500
    expect(Array.from({ length: 10 }, () => buckets.take('a')).filter(Boolean)).toHaveLength(5)
  })
})
