import { callApi } from '@/lib/server'
import { credential } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(): Promise<Response> {
  try {
    const reply = await callApi('POST', '/v1/admin/checks', await credential(), undefined, undefined, 30_000)
    return Response.json(reply.body, { status: reply.status, headers: reply.retryAfter ? { 'retry-after': String(reply.retryAfter) } : {} })
  } catch {
    return Response.json({ error: { code: 'api_unreachable', message: 'the ledger API is not answering' } }, { status: 502 })
  }
}
