import type { AuditState } from '@/lib/audit'
import { callApi, callTamper, clientKey, unreachable, witnessKey } from '@/lib/server'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    const [tamper, checkpoint, verification, key] = await Promise.all([
      callTamper('GET', '/v1/tamper').catch(() => null),
      callApi('GET', '/v1/audit/checkpoint', clientKey()),
      callApi('GET', '/v1/audit/verification', clientKey()),
      witnessKey(),
    ])
    return Response.json({
      tamper: tamper?.status === 200 ? tamper.body.tamper : null,
      tamperAvailable: tamper !== null && tamper.status !== 503,
      checkpoint: checkpoint.status === 200 ? checkpoint.body : null,
      witnessKey: key,
      verification: verification.status === 200 ? verification.body : null,
    } satisfies AuditState)
  } catch {
    return unreachable()
  }
}
