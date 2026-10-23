import { setTimeout as sleep } from 'node:timers/promises'
import { checkEvents, checkSequenced, checkSettled, readWitness } from '@carwash/invariants'
import type pg from 'pg'
import { acceptAnomalies, settleDay } from './admin.ts'
import type { Journeys } from './journeys.ts'
import type { PaymentsReport } from './report.ts'
import { SETTLEMENT_DAY_SECONDS, WITNESS_URL } from './stack.ts'

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
    report.anomalies = await acceptAnomalies(journeys)
    log(
      `anomalies: ${report.anomalies.open} open, ${report.anomalies.accepted} accepted${report.anomalies.failed.length ? `, refused ${report.anomalies.failed.join('; ')}` : ''}`,
    )
  } catch (error) {
    report.harnessErrors.push(`accepting anomalies: ${String(error)}`)
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
      report.harnessErrors.push(`settling day ${day}: ${String(error)}`)
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
