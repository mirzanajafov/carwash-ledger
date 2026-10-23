import 'server-only'
import { SessionView } from '@carwash/contracts'
import { cookies } from 'next/headers'
import { adminKey, callApi } from './server'

const SECURE = process.env.NODE_ENV === 'production'

const SESSION_COOKIE = SECURE ? '__Host-cw_admin' : 'cw_admin'

export interface AdminSession {
  client: string
  expiresAt: string
}

const ATTRIBUTES = { httpOnly: true, secure: SECURE, sameSite: 'strict', path: '/' } as const

export async function rememberSession(token: string, expiresAt: string): Promise<void> {
  ;(await cookies()).set(SESSION_COOKIE, token, { ...ATTRIBUTES, expires: new Date(expiresAt) })
}

export async function forgetSession(): Promise<void> {
  ;(await cookies()).delete({ name: SESSION_COOKIE, ...ATTRIBUTES })
}

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null
}

export async function adminSession(): Promise<AdminSession | null> {
  const token = await sessionToken()
  if (!token) return null
  const reply = await callApi('GET', '/v1/admin/sessions/current', token, { timeoutMs: 5000 }).catch(() => null)
  if (reply?.status !== 200) return null
  const session = SessionView.parse(reply.body)
  return { client: session.client, expiresAt: session.expires_at }
}

export async function credential(): Promise<string> {
  return (await sessionToken()) ?? adminKey()
}
