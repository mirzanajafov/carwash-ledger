import 'server-only'
import { WitnessKeyView } from '@carwash/contracts'
import type { Reply } from './plug'

export function apiUrl(): string {
  return (process.env.API_URL ?? 'http://127.0.0.1:3140').replace(/\/+$/, '')
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

export async function callApi(method: string, path: string, key: string | null, body?: unknown, idempotencyKey?: string, timeoutMs = 15_000): Promise<Reply> {
  const response = await fetch(`${apiUrl()}${path}`, {
    method,
    cache: 'no-store',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: body === undefined ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const retryAfter = Number(response.headers.get('retry-after'))
  return {
    status: response.status,
    body: await response.json().catch(() => null),
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  }
}

export function witnessUrl(): string | null {
  return process.env.WITNESS_URL ? process.env.WITNESS_URL.replace(/\/+$/, '') : null
}

export async function callTamper(method: string, path: string, body?: unknown): Promise<Reply> {
  const url = process.env.TAMPER_URL
  if (!url)
    return { status: 503, body: { error: { code: 'not_configured', message: 'the tamper service is not configured on this web server' } }, retryAfter: null }
  const response = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
    method,
    cache: 'no-store',
    headers: { authorization: `Bearer ${secret('TAMPER_TOKEN')}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: response.status, body: await response.json().catch(() => null), retryAfter: null }
}

export async function callPsp(method: string, path: string, body?: unknown): Promise<Reply> {
  const url = process.env.PSP_URL
  if (!url) return { status: 503, body: { error: { code: 'not_configured', message: 'the bank is not configured on this web server' } }, retryAfter: null }
  const response = await fetch(`${url.replace(/\/+$/, '')}${path}`, {
    method,
    cache: 'no-store',
    headers: { authorization: `Bearer ${secret('PSP_ADMIN_KEY')}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  return { status: response.status, body: await response.json().catch(() => null), retryAfter: null }
}

export async function witnessKey(): Promise<string | null> {
  const url = witnessUrl()
  if (!url) return null
  try {
    const response = await fetch(`${url}/v1/key`, { cache: 'no-store', signal: AbortSignal.timeout(3000) })
    if (!response.ok) return null
    return WitnessKeyView.parse(await response.json()).public_key
  } catch {
    return null
  }
}

export function relay(reply: Reply): Response {
  return Response.json(reply.body, { status: reply.status, headers: reply.retryAfter ? { 'retry-after': String(reply.retryAfter) } : {} })
}

export function unreachable(): Response {
  return Response.json({ error: { code: 'unreachable', message: 'a service behind the dashboard is not answering' } }, { status: 502 })
}
