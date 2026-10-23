import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { HealthView } from '@carwash/contracts'
import { CRASH_POINTS, pullThePlug, type CrashPoint } from '@/lib/plug'
import * as z from 'zod/mini'
import { callApi, clientKey, demoMerchant, readBody, refuse } from '@/lib/server'
import { credential } from '@/lib/session'

export const dynamic = 'force-dynamic'

const PlugBody = z.object({ failpoint: z.string() })

export async function POST(request: Request): Promise<Response> {
  const body = await readBody(request, PlugBody)
  const point = CRASH_POINTS.find((p) => p.failpoint === body?.failpoint)
  const admin = await credential()
  if (!point) return refuse(400, 'invalid', 'pick one of the crash points')
  const steps = pullThePlug(
    {
      arm: (failpoint: CrashPoint) => callApi('POST', '/v1/admin/plug', admin, { body: { failpoint } }),
      pay: (key, payment) => callApi('POST', '/v1/payments', clientKey(), { body: payment, idempotencyKey: key, timeoutMs: 12_000 }),
      health: async () => {
        const reply = await callApi('GET', '/health', null, { timeoutMs: 1000 })
        if (reply.status !== 200) return null
        const health = HealthView.parse(reply.body)
        return { pid: health.pid, startedAt: health.started_at }
      },
      checks: () => callApi('POST', '/v1/admin/checks', admin, { timeoutMs: 30_000 }),
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
