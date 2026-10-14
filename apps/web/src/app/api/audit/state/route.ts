import { callApi, callTamper, clientKey, unreachable, witnessKey } from '@/lib/server'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    const [tamper, checkpoint, key] = await Promise.all([
      callTamper('GET', '/v1/tamper').catch(() => null),
      callApi('GET', '/v1/audit/checkpoint', clientKey()),
      witnessKey(),
    ])
    return Response.json({
      tamper: tamper?.status === 200 ? tamper.body.tamper : null,
      tamperAvailable: tamper !== null && tamper.status !== 503,
      checkpoint: checkpoint.status === 200 ? checkpoint.body : null,
      witnessKey: key,
    })
  } catch {
    return unreachable()
  }
}
