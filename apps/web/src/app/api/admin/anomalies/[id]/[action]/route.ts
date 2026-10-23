import { callApi, refuse, relay, unreachable } from '@/lib/server'
import { sessionToken } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(_request: Request, context: { params: Promise<{ id: string; action: string }> }): Promise<Response> {
  const { id, action } = await context.params
  if (!/^\d{1,15}$/.test(id) || (action !== 'accept' && action !== 'dispute')) {
    return refuse(400, 'invalid', 'accept or dispute an anomaly by its id')
  }
  const token = await sessionToken()
  if (!token) return refuse(401, 'unauthorized', 'log in as an admin first')
  try {
    return relay(await callApi('POST', `/v1/admin/anomalies/${id}/${action}`, token, { timeoutMs: 20_000 }))
  } catch {
    return unreachable()
  }
}
