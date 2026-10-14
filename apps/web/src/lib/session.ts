import 'server-only'
import { cookies } from 'next/headers'
import { adminKey, callApi } from './server'

const SECURE = process.env.NODE_ENV === 'production'

export const SESSION_COOKIE = SECURE ? '__Host-cw_admin' : 'cw_admin'

export interface AdminSession {
  client: string
  expiresAt: string
}

export function cookieOptions(expiresAt: string) {
  return { httpOnly: true, secure: SECURE, sameSite: 'strict' as const, path: '/', expires: new Date(expiresAt) }
}

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null
}

export async function adminSession(): Promise<AdminSession | null> {
  const token = await sessionToken()
  if (!token) return null
  try {
    const reply = await callApi('GET', '/v1/admin/sessions/current', token, undefined, undefined, 5000)
    return reply.status === 200 ? { client: String(reply.body.client), expiresAt: String(reply.body.expires_at) } : null
  } catch {
    return null
  }
}

export async function credential(): Promise<string> {
  return (await sessionToken()) ?? adminKey()
}
