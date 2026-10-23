import 'server-only'
import { WitnessKeyView } from '@carwash/contracts'
import * as z from 'zod/mini'
import type { Reply } from './plug'

function baseUrl(name: string): string | undefined {
  return process.env[name]?.replace(/\/+$/, '') || undefined
}

export function apiUrl(): string {
  return baseUrl('API_URL') ?? 'http://127.0.0.1:3140'
}

function secret(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set on the web server`)
  return value
}

export function adminKey(): string {
  return secret('DASHBOARD_ADMIN_KEY')
}

export function clientKey(): string {
  return secret('DASHBOARD_CLIENT_KEY')
}

export function demoMerchant(): string {
  return process.env.DASHBOARD_MERCHANT ?? 'wash_north'
}

export interface CallOptions {
  body?: unknown
  idempotencyKey?: string
  timeoutMs?: number
}

interface Upstream {
  url: string
  token: string | null
  timeoutMs: number
}

async function send(upstream: Upstream, method: string, path: string, options: CallOptions): Promise<Reply> {
  const response = await fetch(`${upstream.url}${path}`, {
    method,
    cache: 'no-store',
    headers: {
      ...(upstream.token ? { authorization: `Bearer ${upstream.token}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
    },
    body: options.body === undefined ? null : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? upstream.timeoutMs),
  })
  const retryAfter = Number(response.headers.get('retry-after'))
  return {
    status: response.status,
    body: await response.json().catch(() => null),
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  }
}

function notConfigured(what: string): Reply {
  return { status: 503, body: { error: { code: 'not_configured', message: `${what} is not configured on this web server` } }, retryAfter: null }
}

export function callApi(method: string, path: string, key: string | null, options: CallOptions = {}): Promise<Reply> {
  return send({ url: apiUrl(), token: key, timeoutMs: 15_000 }, method, path, options)
}

export async function callTamper(method: string, path: string, options: CallOptions = {}): Promise<Reply> {
  const url = baseUrl('TAMPER_URL')
  if (!url) return notConfigured('the tamper service')
  return send({ url, token: secret('TAMPER_TOKEN'), timeoutMs: 30_000 }, method, path, options)
}

export async function callPsp(method: string, path: string, options: CallOptions = {}): Promise<Reply> {
  const url = baseUrl('PSP_URL')
  if (!url) return notConfigured('the bank')
  return send({ url, token: secret('PSP_ADMIN_KEY'), timeoutMs: 5000 }, method, path, options)
}

export async function witnessKey(): Promise<string | null> {
  const url = baseUrl('WITNESS_URL')
  if (!url) return null
  const reply = await send({ url, token: null, timeoutMs: 3000 }, 'GET', '/v1/key', {}).catch(() => null)
  if (reply?.status !== 200) return null
  return WitnessKeyView.safeParse(reply.body).data?.public_key ?? null
}

export async function readBody<T>(request: Request, schema: z.ZodMiniType<T>): Promise<T | undefined> {
  const parsed = schema.safeParse(await request.json().catch(() => null))
  return parsed.success ? parsed.data : undefined
}

export function refuse(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers })
}

export function relay(reply: Reply): Response {
  return Response.json(reply.body, { status: reply.status, headers: reply.retryAfter ? { 'retry-after': String(reply.retryAfter) } : {} })
}

export function unreachable(): Response {
  return refuse(502, 'unreachable', 'a service behind the dashboard is not answering')
}
