import { OpenedSessionView } from '@carwash/contracts'
import * as z from 'zod/mini'
import { callApi, readBody, refuse, relay, unreachable } from '@/lib/server'
import { forgetSession, rememberSession, sessionToken } from '@/lib/session'

export const dynamic = 'force-dynamic'

const LoginBody = z.object({ key: z.string() })

export async function POST(request: Request): Promise<Response> {
  const key = (await readBody(request, LoginBody))?.key.trim() ?? ''
  if (!/^cw_admin_[\w-]{16,200}$/.test(key)) return refuse(400, 'invalid', 'that is not an admin key')
  try {
    const reply = await callApi('POST', '/v1/admin/sessions', key)
    if (reply.status === 401 || reply.status === 403) return refuse(401, 'unauthorized', 'that key is not an admin key here')
    if (reply.status !== 201) return relay(reply)
    const session = OpenedSessionView.parse(reply.body)
    await rememberSession(session.token, session.expires_at)
    return Response.json({ admin: true, client: session.client, expires_at: session.expires_at }, { status: 201 })
  } catch {
    return unreachable()
  }
}

export async function DELETE(): Promise<Response> {
  const token = await sessionToken()
  if (token) {
    const reply = await callApi('DELETE', '/v1/admin/sessions/current', token).catch(() => null)
    if (reply === null) return unreachable()
    if (reply.status !== 200 && reply.status !== 401) return relay(reply)
  }
  await forgetSession()
  return Response.json({ admin: false })
}
