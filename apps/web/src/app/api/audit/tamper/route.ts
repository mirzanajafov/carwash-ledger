import * as z from 'zod/mini'
import { callTamper, readBody, refuse, relay, unreachable } from '@/lib/server'

export const dynamic = 'force-dynamic'

const TamperBody = z.object({ class: z.union([z.literal(1), z.literal(2), z.literal(3)]) })

export async function POST(request: Request): Promise<Response> {
  const body = await readBody(request, TamperBody)
  if (!body) return refuse(400, 'invalid', 'class must be 1, 2 or 3')
  return callTamper('POST', '/v1/tamper', { class: body.class }).then(relay, unreachable)
}
