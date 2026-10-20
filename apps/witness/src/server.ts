import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { Refusal, Witness, type Submission } from './witness.ts'

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size <= 1_000_000) chunks.push(chunk)
  }
  if (size > 1_000_000) throw new Refusal('too_large', 'the body is over 1 MB')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Refusal('invalid', 'the body is not JSON')
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const HASH = /^[0-9a-f]{64}$/

function submission(input: unknown): Submission {
  const body = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const size = body.size
  const fromSize = body.from_size ?? 0
  const proof = body.proof ?? []
  if (!Number.isSafeInteger(size) || (size as number) < 1) throw new Refusal('invalid', 'size must be a positive integer')
  if (!Number.isSafeInteger(fromSize) || (fromSize as number) < 0) throw new Refusal('invalid', 'from_size must be a non-negative integer')
  if (typeof body.root !== 'string' || !HASH.test(body.root)) throw new Refusal('invalid', 'root must be 32 bytes of hex')
  if (!Array.isArray(proof) || proof.length > 64 || !proof.every((p) => typeof p === 'string' && HASH.test(p))) {
    throw new Refusal('invalid', 'proof must be a list of hex hashes')
  }
  return { size: size as number, root: body.root, from_size: fromSize as number, proof: proof as string[] }
}

export function createWitnessServer(witness: Witness, token: string): Server {
  const routes = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://witness')
    const route = `${request.method} ${url.pathname}`
    if (route === 'GET /health') return send(response, 200, { ok: true })
    if (route === 'GET /v1/key') return send(response, 200, { origin: witness.origin, algorithm: 'ed25519', public_key: witness.publicKey })
    if (route === 'GET /v1/checkpoints/latest') {
      const latest = witness.latest()
      if (!latest) return send(response, 404, { error: { code: 'none', message: 'nothing is signed yet' } })
      return send(response, 200, latest)
    }
    if (route === 'GET /v1/checkpoints') return send(response, 200, { data: witness.history() })
    if (route === 'POST /v1/checkpoints') {
      if (!authorized(request, token)) return send(response, 401, { error: { code: 'unauthorized', message: 'the submitter token is missing or wrong' } })
      const { signed, fresh } = await witness.submit(submission(await readBody(request)))
      return send(response, fresh ? 201 : 200, signed)
    }
    send(response, 404, { error: { code: 'not_found', message: `no route ${route}` } })
  }
  return createServer((request, response) => {
    routes(request, response).catch((error: unknown) => {
      if (response.headersSent) return
      if (error instanceof Refusal) {
        const status = error.code === 'invalid' ? 400 : error.code === 'too_large' ? 413 : 409
        return send(response, status, { error: { code: error.code, message: error.message } })
      }
      send(response, 500, { error: { code: 'internal_error', message: 'internal error' } })
    })
  })
}
