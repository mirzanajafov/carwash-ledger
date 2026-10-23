import { describe, expect, it } from 'vitest'
import { canonicalJson, requestHash } from '../src/index.ts'

describe('request hashing', () => {
  it('writes JSON with its keys sorted at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}')
    expect(canonicalJson(undefined)).toBe('null')
  })

  it('ignores key order but not values or the path', () => {
    const hash = requestHash('POST', '/v1/payments', { amount: 1, currency: 'EUR' })
    expect(requestHash('POST', '/v1/payments', { currency: 'EUR', amount: 1 }).equals(hash)).toBe(true)
    expect(requestHash('POST', '/v1/payments', { currency: 'EUR', amount: 2 }).equals(hash)).toBe(false)
    expect(requestHash('POST', '/v1/payouts', { currency: 'EUR', amount: 1 }).equals(hash)).toBe(false)
  })
})
