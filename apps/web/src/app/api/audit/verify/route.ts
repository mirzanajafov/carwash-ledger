import { adminKey, callApi, relay, unreachable } from '@/lib/server'

export const dynamic = 'force-dynamic'

export async function POST(): Promise<Response> {
  return callApi('POST', '/v1/admin/verify', adminKey(), undefined, undefined, 60_000).then(relay, unreachable)
}
