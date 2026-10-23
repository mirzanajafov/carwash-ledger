import { once } from 'node:events'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod/mini'
import { HttpError, onlyFields, parse, readJson, serve, type Reply } from '../src/index.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function start(handle: (request: IncomingMessage) => Promise<Reply | undefined>, mapError?: (error: unknown) => HttpError | undefined) {
  const logged: string[] = []
  const server = serve(handle, { name: 'test', log: (message) => logged.push(message), mapError })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logged }
}

async function answer(response: Response) {
  const body: unknown = await response.json()
  return { status: response.status, body }
}

async function post(url: string, body: string) {
  return answer(await fetch(url, { method: 'POST', body }))
}

describe('reading a JSON body', () => {
  const echo = (request: IncomingMessage): Promise<Reply> => readJson(request, 100, 'bad_body').then((json) => ({ status: 200, json }))

  it('reads an empty body as an empty object', async () => {
    const { url } = await start(echo)
    expect(await post(url, '')).toEqual({ status: 200, body: {} })
  })

  it('answers 400 with the given code for a body that is not JSON', async () => {
    const { url } = await start(echo)
    expect(await post(url, '{"a":')).toEqual({ status: 400, body: { error: { code: 'bad_body', message: 'the body is not JSON' } } })
  })

  it('reads all of an oversized body before it answers 413, so the client sees the answer', async () => {
    const { url } = await start(echo)
    for (let i = 0; i < 5; i++) {
      expect(await post(url, JSON.stringify({ note: 'x'.repeat(100_000) }))).toEqual({
        status: 413,
        body: { error: { code: 'too_large', message: 'the body is larger than 100 bytes' } },
      })
    }
  })
})

describe('parsing input', () => {
  const Body = onlyFields({ amount: z.int({ error: 'amount must be an integer' }) }, 'unknown field', 'the body must be a JSON object')

  it('reports the first problem with the code it is given', () => {
    expect(() => parse(Body, { amount: 'x' }, 'invalid_request')).toThrow(new HttpError(400, 'invalid_request', 'amount must be an integer'))
    expect(() => parse(Body, { amount: 1, card: '4242' })).toThrow('unknown field card')
    expect(() => parse(Body, null)).toThrow('the body must be a JSON object')
    expect(parse(Body, { amount: 3 })).toEqual({ amount: 3 })
  })
})

describe('serving replies', () => {
  class Refused extends Error {}

  it('answers an HTTP error and a mapped domain error with their status, and anything else with a logged 500', async () => {
    const { url, logged } = await start(
      async (request) => {
        if (request.url === '/http') throw new HttpError(404, 'not_found', 'no such thing')
        if (request.url === '/domain') throw new Refused('taken')
        throw new Error('boom')
      },
      (error) => (error instanceof Refused ? new HttpError(409, 'refused', error.message) : undefined),
    )
    expect(await answer(await fetch(`${url}/http`))).toEqual({ status: 404, body: { error: { code: 'not_found', message: 'no such thing' } } })
    expect(await answer(await fetch(`${url}/domain`))).toEqual({ status: 409, body: { error: { code: 'refused', message: 'taken' } } })
    expect(await answer(await fetch(`${url}/other`))).toEqual({ status: 500, body: { error: { code: 'internal_error', message: 'internal error' } } })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('test: Error: boom')
  })

  it('sends text and streams, and closes the connection when the handler gives no reply', async () => {
    async function* lines() {
      yield '{"data":['
      yield '1,2'
      yield ']}'
    }
    const { url } = await start(async (request) => {
      if (request.url === '/text') return { status: 200, text: 'a,b\n', contentType: 'text/csv' }
      if (request.url === '/stream') return { status: 200, stream: lines(), contentType: 'application/json' }
      return undefined
    })
    const text = await fetch(`${url}/text`)
    expect([text.headers.get('content-type'), await text.text()]).toEqual(['text/csv', 'a,b\n'])
    expect(await fetch(`${url}/stream`).then((r) => r.json())).toEqual({ data: [1, 2] })
    await expect(fetch(`${url}/none`)).rejects.toThrow()
  })

  it('logs an error that happens after the answer has started, without writing a second answer', async () => {
    async function* failing() {
      yield '{"data":['
      throw new Error('the disk went away')
    }
    const { url, logged } = await start(async () => ({ status: 200, stream: failing(), contentType: 'application/json' }))
    await expect(fetch(url).then((r) => r.text())).rejects.toThrow()
    await expect.poll(() => logged.join('\n')).toContain('the disk went away')
  })
})
