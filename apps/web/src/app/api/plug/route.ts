import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { HealthView } from '@carwash/contracts'
import { CRASH_POINTS, pullThePlug, type CrashPoint } from '@/lib/plug'
import { callApi, clientKey, demoMerchant } from '@/lib/server'
import { credential } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { failpoint?: unknown }
  const point = CRASH_POINTS.find((p) => p.failpoint === body.failpoint)
  const admin = await credential()
  if (!point) return Response.json({ error: { code: 'invalid', message: 'pick one of the crash points' } }, { status: 400 })
  const steps = pullThePlug(
    {
      arm: (failpoint: CrashPoint) => callApi('POST', '/v1/admin/plug', admin, { failpoint }),
      pay: (key, payment) => callApi('POST', '/v1/payments', clientKey(), payment, key, 12_000),
      health: async () => {
        const reply = await callApi('GET', '/health', null, undefined, undefined, 1000)
        if (reply.status !== 200) return null
        const health = HealthView.parse(reply.body)
        return { pid: health.pid, startedAt: health.started_at }
      },
      checks: () => callApi('POST', '/v1/admin/checks', admin, undefined, undefined, 30_000),
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
        if (done) controller.close()
        else controller.enqueue(encoder.encode(`${JSON.stringify({ ...value, at: Math.round(value.at) })}\n`))
      } catch (error) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ kind: 'failed', at: 0, message: error instanceof Error ? error.message : String(error) })}\n`))
        controller.close()
      }
    },
    async cancel() {
      await steps.return(undefined)
    },
  })
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } })
}
