import { setTimeout as sleep } from 'node:timers/promises'
import { AnomalyList, AnomalyView, errorOf, SettlementView, VerificationRunView } from '@carwash/contracts'
import type { Journeys } from './journeys.ts'
import type { PaymentsReport } from './report.ts'
import { ADMIN_KEY, API_PORTS, PSP_ADMIN_KEY, PSP_PORT } from './stack.ts'

export async function currentPspFaults(): Promise<string> {
  return (await fetch(`http://127.0.0.1:${PSP_PORT}/admin/faults`, { headers: { authorization: `Bearer ${PSP_ADMIN_KEY}` } })).text()
}

export async function acceptAnomalies(journeys: Journeys): Promise<PaymentsReport['anomalies']> {
  const base = `http://127.0.0.1:${API_PORTS[0]}/v1/admin/anomalies`
  const headers = { authorization: `Bearer ${ADMIN_KEY}` }
  const listed = await fetch(`${base}?state=open&limit=200`, { headers })
  if (listed.status !== 200) throw new Error(`listing anomalies: status ${listed.status}`)
  const open = AnomalyList.parse(await listed.json()).data
  const result: PaymentsReport['anomalies'] = { open: open.length, accepted: 0, failed: [] }
  for (const anomaly of open.filter((a) => a.acceptable)) {
    const response = await fetch(`${base}/${anomaly.id}/accept`, { method: 'POST', headers })
    const body: unknown = await response.json().catch(() => null)
    const accepted = response.status === 200 ? AnomalyView.safeParse(body) : undefined
    if (!accepted?.success) {
      result.failed.push(`${anomaly.id}: ${response.status} ${errorOf(body)?.message ?? ''}`)
      continue
    }
    result.accepted++
    journeys.learnAccepted(accepted.data)
  }
  return result
}

async function verificationRun(path: string, method: string, expected: number): Promise<VerificationRunView | null> {
  const response = await fetch(`http://127.0.0.1:${API_PORTS[0]}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null)
  if (response?.status !== expected) return null
  const body: unknown = await response.json().catch(() => null)
  return body === null ? null : VerificationRunView.parse(body)
}

export function askForVerification(): Promise<VerificationRunView | null> {
  return verificationRun('/v1/admin/verify', 'POST', 202)
}

function latestVerificationRun(): Promise<VerificationRunView | null> {
  return verificationRun('/v1/audit/verification', 'GET', 200)
}

export async function finalVerificationRun(): Promise<VerificationRunView | null> {
  const since = Date.now()
  const deadline = performance.now() + 120_000
  let id: string | undefined
  while (performance.now() < deadline) {
    if (id === undefined) {
      const asked = await askForVerification()
      if (asked && Date.parse(asked.requested_at) >= since) id = asked.id
    } else {
      const latest = await latestVerificationRun()
      if (latest?.id === id && (latest.status === 'done' || latest.status === 'failed')) return latest
    }
    await sleep(500)
  }
  return null
}

export async function settleDay(day: number): Promise<SettlementView> {
  for (let attempt = 0; ; attempt++) {
    try {
      const closed = await fetch(`http://127.0.0.1:${PSP_PORT}/admin/settlements/${day}/close`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${PSP_ADMIN_KEY}` },
        signal: AbortSignal.timeout(5000),
      })
      if (!closed.ok) throw new Error(`closing day ${day}: status ${closed.status}`)
      const response = await fetch(`http://127.0.0.1:${API_PORTS[0]}/v1/settlements/${day}/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_KEY}`, 'idempotency-key': `settle-${day}-${attempt}` },
        signal: AbortSignal.timeout(30_000),
      })
      if (response.status !== 201) throw new Error(`ingesting day ${day}: status ${response.status} ${await response.text()}`)
      return SettlementView.parse(await response.json())
    } catch (error) {
      if (attempt >= 20) throw error
      await sleep(500)
    }
  }
}

export async function setPspFaults(plan: unknown): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PSP_PORT}/admin/faults`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${PSP_ADMIN_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(plan),
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) return
      throw new Error(`status ${response.status}`)
    } catch (error) {
      if (attempt >= 50) throw error
      await sleep(200)
    }
  }
}
