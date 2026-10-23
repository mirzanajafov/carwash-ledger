import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifySignature } from '../src/webhooks/signature.ts'

describe('verifying a webhook signature', () => {
  const body = '{"id":"evt_1"}'
  const at = 1_700_000_000
  const header = `t=${at},v1=${createHmac('sha256', 'whsec').update(`${at}.${body}`).digest('hex')}`

  it('accepts the PSP scheme inside five minutes and nothing else', () => {
    expect(verifySignature('whsec', body, header, at + 299)).toBe(true)
    expect(verifySignature('whsec', body, header, at + 301)).toBe(false)
    expect(verifySignature('whsec', `${body} `, header, at)).toBe(false)
    expect(verifySignature('other', body, header, at)).toBe(false)
    expect(verifySignature('whsec', body, header.slice(header.indexOf('v1=')), at)).toBe(false)
    expect(verifySignature('whsec', body, `t=${at},v1=zz`, at)).toBe(false)
    expect(verifySignature('whsec', body, '', at)).toBe(false)
  })
})
