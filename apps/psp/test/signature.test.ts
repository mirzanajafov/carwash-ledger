import { describe, expect, it } from 'vitest'
import { retryDelaySeconds } from '../src/delivery.ts'
import { canonicalJson, requestHash } from '../src/psp.ts'
import { signatureHeader, verifySignature } from '../src/signature.ts'

describe('webhook signatures', () => {
  const secret = 'whsec_test'
  const body = '{"id":"evt_1","type":"operation.succeeded"}'

  it('verifies its own signature inside the window and nothing else', () => {
    const header = signatureHeader(secret, body, 1_700_000_000)
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/)
    expect(verifySignature(secret, body, header, 1_700_000_100)).toBe(true)
    expect(verifySignature(secret, `${body} `, header, 1_700_000_100)).toBe(false)
    expect(verifySignature('whsec_other', body, header, 1_700_000_100)).toBe(false)
    expect(verifySignature(secret, body, header, 1_700_000_301)).toBe(false)
    expect(verifySignature(secret, body, 't=1700000000', 1_700_000_000)).toBe(false)
    expect(verifySignature(secret, body, 'garbage', 1_700_000_000)).toBe(false)
  })
})

describe('request hashing', () => {
  it('ignores key order but not values or the path', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}')
    const hash = requestHash('POST', '/v1/charges', { amount: 1500, currency: 'EUR' })
    expect(requestHash('POST', '/v1/charges', { currency: 'EUR', amount: 1500 }).equals(hash)).toBe(true)
    expect(requestHash('POST', '/v1/charges', { currency: 'EUR', amount: 1501 }).equals(hash)).toBe(false)
    expect(requestHash('POST', '/v1/payouts', { currency: 'EUR', amount: 1500 }).equals(hash)).toBe(false)
  })
})

describe('retryDelaySeconds', () => {
  it('doubles from one second and stops at a minute', () => {
    expect([1, 2, 3, 4, 7, 8, 20].map(retryDelaySeconds)).toEqual([1, 2, 4, 8, 60, 60, 60])
  })
})
