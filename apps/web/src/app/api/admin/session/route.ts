import { OpenedSessionView } from '@carwash/contracts'
import { cookies } from 'next/headers'
import { callApi, unreachable } from '@/lib/server'
import { adminSession, cookieOptions, SESSION_COOKIE, sessionToken } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const session = await adminSession()
  if (!session && (await sessionToken())) (await cookies()).delete(SESSION_COOKIE)
  return Response.json(session ? { admin: true, client: session.client, expires_at: session.expiresAt } : { admin: false })
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { key?: unknown }
  const key = typeof body.key === 'string' ? body.key.trim() : ''
  if (!/^cw_admin_[\w-]{16,200}$/.test(key)) return Response.json({ error: { code: 'invalid', message: 'that is not an admin key' } }, { status: 400 })
  try {
    const reply = await callApi('POST', '/v1/admin/sessions', key)
    if (reply.status === 401 || reply.status === 403)
      return Response.json({ error: { code: 'unauthorized', message: 'that key is not an admin key here' } }, { status: 401 })
    if (reply.status !== 201) return Response.json(reply.body, { status: reply.status })
    const session = OpenedSessionView.parse(reply.body)
    ;(await cookies()).set(SESSION_COOKIE, session.token, cookieOptions(session.expires_at))
    return Response.json({ admin: true, client: session.client, expires_at: session.expires_at }, { status: 201 })
  } catch {
    return unreachable()
  }
}

export async function DELETE(): Promise<Response> {
  const token = await sessionToken()
  if (token) await callApi('DELETE', '/v1/admin/sessions/current', token).catch(() => null)
  ;(await cookies()).delete(SESSION_COOKIE)
  return Response.json({ admin: false })
}
