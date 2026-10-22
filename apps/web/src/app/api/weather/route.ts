import { callPsp, relay, unreachable } from '@/lib/server'
import { adminSession } from '@/lib/session'
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

function refuse(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers })
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { preset?: unknown; custom?: { plan?: unknown; minutes?: unknown } }
  try {
    if (body.custom !== undefined) {
      if (!(await adminSession())) return refuse(403, 'forbidden', 'only an admin session can set its own weather')
      const minutes = Number(body.custom.minutes)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) return refuse(400, 'invalid', 'minutes must be a whole number from 1 to 60')
      return relay(await callPsp('PUT', '/admin/weather', { label: 'custom', plan: body.custom.plan, seconds: minutes * 60 }))
    }
    const preset = presetNamed(body.preset)
    if (!preset) return refuse(400, 'invalid', 'pick one of the presets')
    if (!preset.plan) return relay(await callPsp('DELETE', '/admin/weather'))
    if (!(await adminSession())) {
      const wait = turn.take(Date.now())
      if (wait > 0) return refuse(429, 'rate_limited', `the weather changed less than a minute ago, so try again in ${wait} s`, { 'retry-after': String(wait) })
    }
    return relay(await callPsp('PUT', '/admin/weather', { label: preset.name, plan: preset.plan, seconds: VISITOR_SECONDS }))
  } catch {
    return unreachable()
  }
}
