import { describe, expect, it } from 'vitest'
import { failureNote, refusal } from './use-action'

describe('what a panel says when an action fails', () => {
  it("shows the web server's message, or the status when it gave none", () => {
    expect(refusal({ ok: false, status: 429, body: { error: { code: 'rate_limited', message: 'slow down and try again in 5 s' } } })).toBe(
      'slow down and try again in 5 s',
    )
    expect(refusal({ ok: false, status: 502, body: null })).toBe('The web server answered 502.')
    expect(refusal({ ok: true, status: 200, body: {} })).toBeUndefined()
  })

  it('tells a server that stopped answering apart from an answer the page could not read', () => {
    expect(failureNote(new TypeError('Failed to fetch'))).toBe('The web server stopped answering.')
    expect(failureNote(new SyntaxError('Unexpected token'))).toBe('This page could not read what the web server answered.')
  })
})
