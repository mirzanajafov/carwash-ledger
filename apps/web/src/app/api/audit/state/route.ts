import { CheckpointView, TamperState, VerificationRunView } from '@carwash/contracts'
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
      tamper: tamper?.status === 200 ? (TamperState.safeParse(tamper.body).data?.tamper ?? null) : null,
      tamperAvailable: tamper?.status === 200,
      checkpoint: checkpoint.status === 200 ? (CheckpointView.safeParse(checkpoint.body).data ?? null) : null,
      witnessKey: key,
      verification: verification.status === 200 ? (VerificationRunView.safeParse(verification.body).data ?? null) : null,
    } satisfies AuditState)
  } catch {
    return unreachable()
  }
}
