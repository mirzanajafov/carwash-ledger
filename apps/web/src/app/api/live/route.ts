import { apiUrl } from '@/lib/server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetch(`${apiUrl()}/v1/live`, { signal: request.signal, cache: 'no-store' })
  } catch {
    return Response.json({ error: { code: 'api_unreachable', message: 'the ledger API is not answering' } }, { status: 502 })
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } })
  }
  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}
