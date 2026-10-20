import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Conflict, type TamperService } from './service.ts'

class BodyTooLarge extends Error {}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > 10_000) throw new BodyTooLarge()
    chunks.push(chunk as Buffer)
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export function createTamperServer(service: TamperService, token: string): Server {
  const routes = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const route = `${request.method} ${new URL(request.url ?? '/', 'http://tamper').pathname}`
    if (route === 'GET /health') return send(response, 200, { ok: true })
    if (!authorized(request, token)) return send(response, 401, { error: { code: 'unauthorized', message: 'the token is missing or wrong' } })
    if (route === 'GET /v1/tamper') return send(response, 200, { tamper: service.current() })
    if (route === 'POST /v1/tamper') {
      const body = (await readBody(request)) as { class?: unknown }
      if (body.class !== 1 && body.class !== 2 && body.class !== 3) {
        return send(response, 400, { error: { code: 'invalid', message: 'class must be 1, 2 or 3' } })
      }
      return send(response, 201, { tamper: await service.tamper(body.class) })
    }
    if (route === 'POST /v1/restore') return send(response, 200, { restored: await service.restore() })
    send(response, 404, { error: { code: 'not_found', message: `no route ${route}` } })
  }
  return createServer((request, response) => {
    routes(request, response).catch((error: unknown) => {
      if (response.headersSent) return
      if (error instanceof Conflict) return send(response, 409, { error: { code: error.code, message: error.message } })
      if (error instanceof BodyTooLarge) return send(response, 413, { error: { code: 'too_large', message: 'the body is over 10 kB' } })
      if (error instanceof SyntaxError) return send(response, 400, { error: { code: 'invalid', message: 'the body is not JSON' } })
      send(response, 500, { error: { code: 'internal_error', message: 'internal error' } })
    })
  })
}
