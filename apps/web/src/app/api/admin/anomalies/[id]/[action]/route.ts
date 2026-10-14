import { callApi, relay, unreachable } from '@/lib/server'
import { sessionToken } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(_request: Request, context: { params: Promise<{ id: string; action: string }> }): Promise<Response> {
  const { id, action } = await context.params
  if (!/^\d{1,15}$/.test(id) || (action !== 'accept' && action !== 'dispute')) {
    return Response.json({ error: { code: 'invalid', message: 'accept or dispute an anomaly by its id' } }, { status: 400 })
  }
  const token = await sessionToken()
  if (!token) return Response.json({ error: { code: 'unauthorized', message: 'log in as an admin first' } }, { status: 401 })
  try {
    return relay(await callApi('POST', `/v1/admin/anomalies/${id}/${action}`, token, undefined, undefined, 20_000))
  } catch {
    return unreachable()
  }
}
