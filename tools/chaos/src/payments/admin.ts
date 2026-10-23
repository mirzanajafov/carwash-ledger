import { setTimeout as sleep } from 'node:timers/promises'
import { VerificationRunView } from '@carwash/contracts'
import { ADMIN_KEY, API_PORTS, PSP_ADMIN_KEY, PSP_PORT } from './stack.ts'

export async function currentPspFaults(): Promise<string> {
  return (await fetch(`http://127.0.0.1:${PSP_PORT}/admin/faults`, { headers: { authorization: `Bearer ${PSP_ADMIN_KEY}` } })).text()
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

export async function completedVerificationRun(): Promise<VerificationRunView | null> {
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
