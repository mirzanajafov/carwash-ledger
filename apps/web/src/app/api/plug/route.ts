import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { CRASH_POINTS, pullThePlug, type CrashPoint } from '@/lib/plug'
import { adminKey, callApi, clientKey, demoMerchant } from '@/lib/server'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { failpoint?: unknown }
  const point = CRASH_POINTS.find((p) => p.failpoint === body.failpoint)
  if (!point) return Response.json({ error: { code: 'invalid', message: 'pick one of the crash points' } }, { status: 400 })
  const steps = pullThePlug(
    {
      arm: (failpoint: CrashPoint) => callApi('POST', '/v1/admin/plug', adminKey(), { failpoint }),
      pay: (key, payment) => callApi('POST', '/v1/payments', clientKey(), payment, key, 12_000),
      health: async () => {
        const reply = await callApi('GET', '/health', null, undefined, undefined, 1000)
        return reply.status === 200 ? { pid: Number(reply.body.pid), startedAt: String(reply.body.started_at) } : null
      },
      checks: () => callApi('POST', '/v1/admin/checks', adminKey(), undefined, undefined, 30_000),
      key: () => randomUUID(),
      sleep: (ms) => sleep(ms),
      now: () => performance.now(),
    },
    point.failpoint,
    demoMerchant(),
  )
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await steps.next()
        if (done) return controller.close()
        controller.enqueue(encoder.encode(`${JSON.stringify({ ...value, at: Math.round(value.at) })}\n`))
      } catch (error) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ kind: 'failed', at: 0, message: (error as Error).message })}\n`))
        controller.close()
      }
    },
    async cancel() {
      await steps.return(undefined)
    },
  })
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } })
}
