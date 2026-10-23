import { clientIp, Streams } from '@/lib/limits'
import { apiUrl, refuse, unreachable } from '@/lib/server'

export const dynamic = 'force-dynamic'

const streams = new Streams(3)

export async function GET(request: Request): Promise<Response> {
  const release = streams.open(clientIp(request.headers.get('x-forwarded-for')))
  if (!release) return refuse(429, 'too_many_streams', 'this address already has three live pages open')
  request.signal.addEventListener('abort', release)
  let upstream: Response
  try {
    upstream = await fetch(`${apiUrl()}/v1/live`, { signal: request.signal, cache: 'no-store' })
  } catch {
    release()
    return unreachable()
  }
  if (!upstream.ok || !upstream.body) {
    release()
    return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } })
  }
  const reader = upstream.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          release()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    cancel(reason) {
      release()
      return reader.cancel(reason)
    },
  })
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}
