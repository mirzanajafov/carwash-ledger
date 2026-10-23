import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { text } from 'node:stream/consumers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod/mini'
import { callApi, callTamper, readBody, relay } from './server'

interface Seen {
  method: string | undefined
  url: string | undefined
  headers: IncomingHttpHeaders
  body: string
}

async function upstream(status: number, headers: Record<string, string>, body: unknown) {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    void text(request).then((raw) => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: raw })
      response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, seen, close: () => server.close() }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the upstream client', () => {
  it('sends the key, the idempotency key and the body, and relays the status, the body and retry-after', async () => {
    const api = await upstream(429, { 'retry-after': '7' }, { error: { code: 'rate_limited', message: 'slow down' } })
    vi.stubEnv('API_URL', api.url)
    try {
      const reply = await callApi('POST', '/v1/payments', 'cw_key', { body: { amount: 900 }, idempotencyKey: 'k1' })
      expect(api.seen.map(({ method, url, body }) => ({ method, url, body }))).toEqual([{ method: 'POST', url: '/v1/payments', body: '{"amount":900}' }])
      expect(api.seen[0]?.headers).toMatchObject({ authorization: 'Bearer cw_key', 'idempotency-key': 'k1', 'content-type': 'application/json' })
      expect(reply).toEqual({ status: 429, body: { error: { code: 'rate_limited', message: 'slow down' } }, retryAfter: 7 })
      const relayed = relay(reply)
      expect(relayed.status).toBe(429)
      expect(relayed.headers.get('retry-after')).toBe('7')
      expect(await relayed.json()).toEqual({ error: { code: 'rate_limited', message: 'slow down' } })
    } finally {
      api.close()
    }
  })

  it('says a service is not configured instead of calling nowhere', async () => {
    vi.stubEnv('TAMPER_URL', '')
    expect(await callTamper('GET', '/v1/tamper')).toEqual({
      status: 503,
      body: { error: { code: 'not_configured', message: 'the tamper service is not configured on this web server' } },
      retryAfter: null,
    })
  })

  it('reads a request body only when it matches the schema', async () => {
    const Body = z.object({ class: z.number() })
    const request = (body: string) => new Request('http://localhost/api', { method: 'POST', body })
    expect(await readBody(request('{"class":2}'), Body)).toEqual({ class: 2 })
    expect(await readBody(request('{"class":"2"}'), Body)).toBeUndefined()
    expect(await readBody(request('not json'), Body)).toBeUndefined()
  })
})
