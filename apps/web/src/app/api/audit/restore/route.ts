import { callTamper, relay, unreachable } from '@/lib/server'

export const dynamic = 'force-dynamic'

export async function POST(): Promise<Response> {
  return callTamper('POST', '/v1/restore').then(relay, unreachable)
}
