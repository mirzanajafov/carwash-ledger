import { callApi, relay, unreachable } from '@/lib/server'
import { credential } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(): Promise<Response> {
  return credential()
    .then((key) => callApi('POST', '/v1/admin/verify', key))
    .then(relay, unreachable)
}
