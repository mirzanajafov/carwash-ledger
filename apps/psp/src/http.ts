import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

export const MAX_BODY_BYTES = 16 * 1024
export const MAX_AMOUNT = 100_000_000_000

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

export function badRequest(message: string): HttpError {
  return new HttpError(400, 'invalid_request', message)
}

export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large', `the body is larger than ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw badRequest('the body is not valid JSON')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('the body must be a JSON object')
  return body as Record<string, unknown>
}

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers })
  response.end(text)
}

export function sendError(response: ServerResponse, error: HttpError): void {
  sendJson(response, error.status, { error: { code: error.code, message: error.message } })
}

export function bearerMatches(request: IncomingMessage, secret: string): boolean {
  const header = request.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(secret)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw badRequest(`unknown field ${key}`)
  }
}

export function amountField(body: Record<string, unknown>, name: string): number {
  const value = body[name]
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_AMOUNT) {
    throw badRequest(`${name} must be an integer from 1 to ${MAX_AMOUNT} in minor units`)
  }
  return value as number
}

export function optionalAmountField(body: Record<string, unknown>, name: string): number | undefined {
  return body[name] === undefined ? undefined : amountField(body, name)
}

export function currencyField(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw badRequest(`${name} must be a three-letter currency code`)
  return value
}

export function textField(body: Record<string, unknown>, name: string, maxLength = 200): string {
  const value = body[name]
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw badRequest(`${name} must be a string of 1 to ${maxLength} characters`)
  }
  return value
}
