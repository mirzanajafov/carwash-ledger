import { callApi, relay, unreachable } from '@/lib/server'
import { credential } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(): Promise<Response> {
  return callApi('POST', '/v1/admin/checks', await credential(), { timeoutMs: 30_000 }).then(relay, unreachable)
}
