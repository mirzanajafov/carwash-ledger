import { describe, expect, it } from 'vitest'
import { Buckets, clientIp, ruleFor, RULES, Streams } from './limits'

describe('the web limits', () => {
  it('lets a burst through, then one request per refill, and says how long to wait', () => {
    const buckets = new Buckets()
    const at = 1_000_000
    for (let i = 0; i < 3; i++) expect(buckets.take('1.2.3.4', RULES.heavy, at)).toBe(0)
    expect(buckets.take('1.2.3.4', RULES.heavy, at)).toBe(5)
    expect(buckets.take('5.6.7.8', RULES.heavy, at)).toBe(0)
    expect(buckets.take('1.2.3.4', RULES.heavy, at + 4000)).toBe(1)
    expect(buckets.take('1.2.3.4', RULES.heavy, at + 5000)).toBe(0)
  })

  it('forgets visitors that have been quiet for a while', () => {
    const buckets = new Buckets(1000)
    buckets.take('a', RULES.api, 0)
    buckets.take('b', RULES.api, 800)
    buckets.take('c', RULES.api, 1700)
    expect(buckets.size).toBe(2)
  })

  it('treats the actions that kill, tamper or scan as heavy and leaves pages alone', () => {
    expect(ruleFor('POST', '/api/plug')).toBe('heavy')
    expect(ruleFor('POST', '/api/audit/tamper')).toBe('heavy')
    expect(ruleFor('GET', '/api/audit/state')).toBe('api')
    expect(ruleFor('GET', '/api/live')).toBe('api')
    expect(ruleFor('GET', '/audit')).toBeNull()
  })

  it('reads the client from the first forwarded address', () => {
    expect(clientIp('203.0.113.7, 172.18.0.5')).toBe('203.0.113.7')
    expect(clientIp(null)).toBe('unknown')
    expect(clientIp('')).toBe('unknown')
  })

  it('caps open live streams per visitor and frees a slot exactly once', () => {
    const streams = new Streams(2)
    const first = streams.open('ip')!
    const second = streams.open('ip')!
    expect(streams.open('ip')).toBeNull()
    first()
    first()
    expect(streams.open('ip')).not.toBeNull()
    expect(streams.open('ip')).toBeNull()
    second()
    expect(streams.open('other')).not.toBeNull()
  })
})
