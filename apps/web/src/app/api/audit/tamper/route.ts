import { callTamper, relay, unreachable } from '@/lib/server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { class?: unknown }
  if (body.class !== 1 && body.class !== 2 && body.class !== 3) return Response.json({ error: { code: 'invalid', message: 'class must be 1, 2 or 3' } }, { status: 400 })
  return callTamper('POST', '/v1/tamper', { class: body.class }).then(relay, unreachable)
}
