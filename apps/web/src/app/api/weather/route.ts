import { callPsp, relay, unreachable } from '@/lib/server'
import { presetNamed, Turn, VISITOR_EVERY_MS, VISITOR_SECONDS } from '@/lib/weather'

export const dynamic = 'force-dynamic'

const turn = new Turn(VISITOR_EVERY_MS)

export async function GET(): Promise<Response> {
  try {
    return relay(await callPsp('GET', '/admin/weather'))
  } catch {
    return unreachable()
  }
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { preset?: unknown }
  const preset = presetNamed(body.preset)
  if (!preset) return Response.json({ error: { code: 'invalid', message: 'pick one of the presets' } }, { status: 400 })
  try {
    if (!preset.plan) return relay(await callPsp('DELETE', '/admin/weather'))
    const wait = turn.take(Date.now())
    if (wait > 0) {
      return Response.json(
        { error: { code: 'rate_limited', message: `the weather changed less than a minute ago; try again in ${wait} s` } },
        { status: 429, headers: { 'retry-after': String(wait) } },
      )
    }
    return relay(await callPsp('PUT', '/admin/weather', { label: preset.name, plan: preset.plan, seconds: VISITOR_SECONDS }))
  } catch {
    return unreachable()
  }
}
