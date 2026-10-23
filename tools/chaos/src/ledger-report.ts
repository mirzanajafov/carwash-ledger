import { median } from '@carwash/lab'
import type { ClientLedger } from './client.ts'
import type { RunPlan, ToxicKind } from './plan.ts'
import { addCounts, byInvariant, type Violation } from './violations.ts'

export interface LedgerReport {
  seed: number
  startedAt: string
  faultPhaseMs: number
  settleMs: number
  settled: boolean
  journeys: number
  captures: number
  reversals: number
  attempts: number
  outcomes: ClientLedger['stats']
  kills: { random: number; failpoints: Record<string, number> }
  workerStarts: number
  crashes: number
  postgres: { kills: number; recoveryMs: number[] }
  toxics: Record<ToxicKind, number>
  snapshots: { taken: number; errors: number }
  checks: { periodic: number; skipped: number }
  harnessErrors: string[]
  violations: Violation[]
}

export function newLedgerReport(seed: number, faultPhaseMs: number, plan: RunPlan, violations: Violation[]): LedgerReport {
  return {
    seed,
    startedAt: new Date().toISOString(),
    faultPhaseMs,
    settleMs: 0,
    settled: true,
    journeys: plan.journeys.length,
    captures: 0,
    reversals: 0,
    attempts: 0,
    outcomes: { posted: 0, conflictRetries: 0, duplicates: 0, retryable: 0, rejected: 0 },
    kills: { random: 0, failpoints: {} },
    workerStarts: 0,
    crashes: 0,
    postgres: { kills: 0, recoveryMs: [] },
    toxics: { latency: 0, timeout: 0, reset_peer: 0, limit_data: 0, down: 0 },
    snapshots: { taken: 0, errors: 0 },
    checks: { periodic: 0, skipped: 0 },
    harnessErrors: [],
    violations,
  }
}

export function summarizeLedger(reports: readonly LedgerReport[]) {
  const sum = (f: (r: LedgerReport) => number) => reports.reduce((total, r) => total + f(r), 0)
  const failpoints: Record<string, number> = {}
  const toxics: Record<string, number> = {}
  for (const r of reports) {
    addCounts(failpoints, r.kills.failpoints)
    addCounts(toxics, r.toxics)
  }
  const firstViolation = reports.findIndex((r) => r.violations.length > 0)
  return {
    runs: reports.length,
    journeys: sum((r) => r.captures + r.reversals),
    attempts: sum((r) => r.attempts),
    conflictRetries: sum((r) => r.outcomes.conflictRetries),
    randomKills: sum((r) => r.kills.random),
    crashes: sum((r) => r.crashes),
    failpointKills: failpoints,
    postgresKills: sum((r) => r.postgres.kills),
    postgresRecoveryMsMedian: median(reports.flatMap((r) => r.postgres.recoveryMs)),
    toxics,
    settleMsMedian: median(reports.map((r) => r.settleMs)),
    settleMsMax: Math.max(...reports.map((r) => r.settleMs)),
    runsWithViolations: reports.filter((r) => r.violations.length > 0).length,
    violationsByInvariant: byInvariant(reports),
    firstViolatingRun: firstViolation === -1 ? null : firstViolation + 1,
    harnessErrors: sum((r) => r.harnessErrors.length),
  }
}

export function describeLedgerRun(index: number, r: LedgerReport): string {
  const failpointKills = Object.values(r.kills.failpoints).reduce((a, b) => a + b, 0)
  const toxics = Object.values(r.toxics).reduce((a, b) => a + b, 0)
  const found = r.violations.length === 0 ? 'no violations' : r.violations.map((v) => `${v.id}/${v.phase} ${v.count}`).join(', ')
  return (
    `run ${index} seed ${r.seed}: ${r.captures + r.reversals} journeys, ${r.attempts} attempts, ` +
    `kills ${r.kills.random} random + ${failpointKills} at failpoints, crashes ${r.crashes}, postgres ${r.postgres.kills}, toxics ${toxics}, ` +
    `settled ${r.settled ? `in ${(r.settleMs / 1000).toFixed(1)} s` : 'NOT'}, ${found}`
  )
}
