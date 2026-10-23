import { setTimeout as sleep } from 'node:timers/promises'
import { AnomalyList, AnomalyView, errorOf, SettlementView } from '@carwash/contracts'
import { checkEvents, checkSequenced, checkSettled, readWitness } from '@carwash/invariants'
import type pg from 'pg'
import { describeError } from '../messages.ts'
import type { Journeys } from './journeys.ts'
import type { PaymentsReport } from './report.ts'
import { ADMIN_KEY, API_PORTS, PSP_ADMIN_KEY, PSP_PORT, SETTLEMENT_DAY_SECONDS, WITNESS_URL } from './stack.ts'

export async function hasSettled(tasks: readonly Promise<unknown>[], probes: readonly Promise<unknown>[], audit: pg.Pool): Promise<boolean> {
  const pending = Symbol('pending')
  const race = await Promise.race([Promise.allSettled([...tasks, ...probes]).then(() => 'done'), sleep(0, pending)])
  if (race === pending) return false
  try {
    if ((await checkSettled(audit)).count > 0) return false
    if ((await checkSequenced(audit)).count > 0) return false
    return (await checkEvents(audit)).some((result) => result.id === 'L2' && result.count === 0)
  } catch {
    return false
  }
}

export async function acceptOpenAnomalies(report: PaymentsReport, journeys: Journeys, log: (line: string) => void): Promise<void> {
  try {
    report.anomalies = await acceptEach(journeys)
    log(
      `anomalies: ${report.anomalies.open} open, ${report.anomalies.accepted} accepted${report.anomalies.failed.length ? `, refused ${report.anomalies.failed.join('; ')}` : ''}`,
    )
  } catch (error) {
    report.harnessErrors.push(`accepting anomalies: ${describeError(error)}`)
  }
}

export async function settleDays(report: PaymentsReport, log: (line: string) => void): Promise<void> {
  const firstDay = Math.floor(Date.parse(report.startedAt) / 1000 / SETTLEMENT_DAY_SECONDS)
  const lastDay = Math.floor(Date.now() / 1000 / SETTLEMENT_DAY_SECONDS)
  for (let day = firstDay; day <= lastDay; day++) {
    try {
      const settled = await settleDay(day)
      report.settlement.days.push(day)
      report.settlement.outcomes.push(settled.outcome)
      for (const [name, n] of Object.entries(settled.reconciliation?.breaks ?? {})) {
        report.settlement.breaks[name] = (report.settlement.breaks[name] ?? 0) + n
      }
    } catch (error) {
      report.harnessErrors.push(`settling day ${day}: ${describeError(error)}`)
      break
    }
  }
  log(`settled days ${report.settlement.days.join(', ')}: ${report.settlement.outcomes.join(', ')}, breaks ${JSON.stringify(report.settlement.breaks)}`)
}

export async function waitForDelivery(audit: pg.Pool): Promise<void> {
  const drainedBy = performance.now() + 60_000
  while (performance.now() < drainedBy) {
    const delivered = await Promise.all([checkEvents(audit), checkSequenced(audit)])
      .then(([events, sequenced]) => events.some((r) => r.id === 'L2' && r.count === 0) && sequenced.count === 0)
      .catch(() => false)
    if (delivered) break
    await sleep(250)
  }
  const witnessedBy = performance.now() + 30_000
  while (performance.now() < witnessedBy) {
    const current = await readWitness(WITNESS_URL)
      .then(async (witness) => (await checkSequenced(audit, witness)).count === 0)
      .catch(() => false)
    if (current) break
    await sleep(250)
  }
}

async function acceptEach(journeys: Journeys): Promise<PaymentsReport['anomalies']> {
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

async function settleDay(day: number): Promise<SettlementView> {
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
