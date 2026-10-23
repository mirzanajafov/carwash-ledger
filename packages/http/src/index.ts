import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type * as z from 'zod/mini'

export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
  }
}

export type Reply =
  | { status: number; json: unknown; headers?: Record<string, string> }
  | { status: number; text: string; contentType: string }
  | { status: number; stream: AsyncIterable<string>; contentType: string }

export interface ServeOptions {
  name: string
  log?: ((message: string) => void) | undefined
  errorOf?: (error: unknown) => HttpError | undefined
}

export async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size <= maxBytes) chunks.push(chunk)
  }
  if (size > maxBytes) throw new HttpError(413, 'too_large', `the body is larger than ${maxBytes} bytes`)
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid', 'the body is not JSON')
  }
}

export function parse<S extends z.ZodMiniType>(schema: S, input: unknown, code = 'invalid'): z.infer<S> {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw new HttpError(400, code, result.error.issues[0]?.message ?? 'the request is not valid')
}

export function bearerMatches(request: IncomingMessage, secret: string): boolean {
  const header = request.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(secret)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function write(response: ServerResponse, status: number, contentType: string, text: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(text), ...headers })
  response.end(text)
}

async function send(response: ServerResponse, reply: Reply): Promise<void> {
  if ('stream' in reply) {
    response.writeHead(reply.status, { 'content-type': reply.contentType })
    await pipeline(Readable.from(reply.stream), response)
  } else if ('text' in reply) {
    write(response, reply.status, reply.contentType, reply.text)
  } else {
    write(response, reply.status, 'application/json', JSON.stringify(reply.json), reply.headers)
  }
}

function closedEarly(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ERR_STREAM_PREMATURE_CLOSE'
}

export function serve(handle: (request: IncomingMessage) => Promise<Reply | undefined>, options: ServeOptions): Server {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`))
  const fail = (request: IncomingMessage, response: ServerResponse, error: unknown): void => {
    if (response.headersSent || request.socket.destroyed || closedEarly(error)) return
    const known = error instanceof HttpError ? error : options.errorOf?.(error)
    if (!known) log(`${options.name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    const { status, code, message } = known ?? new HttpError(500, 'internal_error', 'internal error')
    write(response, status, 'application/json', JSON.stringify({ error: { code, message } }))
  }
  return createServer((request, response) => {
    handle(request)
      .then((reply) => (reply === undefined ? undefined : send(response, reply)))
      .catch((error: unknown) => {
        fail(request, response, error)
      })
  })
}
