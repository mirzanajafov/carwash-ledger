import 'server-only'
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
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const retryAfter = Number(response.headers.get('retry-after'))
  return { status: response.status, body: await response.json().catch(() => null), retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null }
}
