import { callApi, relay, unreachable } from '@/lib/server'
import { credential } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(): Promise<Response> {
  return credential()
    .then((key) => callApi('POST', '/v1/admin/checks', key, { timeoutMs: 30_000 }))
    .then(relay, unreachable)
}
