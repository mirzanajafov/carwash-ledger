import { median } from '@carwash/lab'
import type { ToxicKind } from '../plan.ts'
import type { ExitKind } from '../service.ts'
import { addCounts, byInvariant, type Violation } from '../violations.ts'
import type { PaymentsPlan, ProxyName, ServiceName } from './plan.ts'

export interface PaymentsReport {
  seed: number
  startedAt: string
  faultPhaseMs: number
  settleMs: number
  settled: boolean
  journeys: number
  payouts: number
  outcomes: Record<string, number>
  payoutOutcomes: Record<string, number>
  requests: number
  sends: number
  duplicates: number
  probes: number
  answers: Record<string, number>
  surprises: { count: number; examples: string[] }
  forged: Record<string, number>
  kills: { random: Record<ServiceName, number>; failpoints: Record<string, number> }
  exits: Record<ExitKind, number>
  crashes: string[]
  starts: Record<string, number>
  postgres: { kills: number; recoveryMs: number[] }
  kafka: { kills: number; recoveryMs: number[] }
  events: Record<string, number>
  settlement: { days: number[]; outcomes: string[]; breaks: Record<string, number> }
  anomalies: { open: number; accepted: number; failed: string[] }
  toxics: Record<ToxicKind, number>
  toxicsByProxy: Record<ProxyName, number>
  ledger: { anomalies: Record<string, number>; webhooks: Record<string, number> }
  pspOperations: Record<string, number>
  checks: { periodic: number; resumed: number; skipped: number }
  witness: { checkpoints: number; size: number; compared: number }
  verification: { requested: number; runs: Record<string, number>; maxAttempts: number }
  harnessErrors: string[]
  violations: Violation[]
}

export function newPaymentsReport(seed: number, faultPhaseMs: number, plan: PaymentsPlan, violations: Violation[]): PaymentsReport {
  return {
    seed,
    startedAt: new Date().toISOString(),
    faultPhaseMs,
    settleMs: 0,
    settled: true,
    journeys: plan.journeys.length,
    payouts: plan.payouts.length,
    outcomes: {},
    payoutOutcomes: {},
    requests: 0,
    sends: 0,
    duplicates: 0,
    probes: 0,
    answers: {},
    surprises: { count: 0, examples: [] },
    forged: {},
    kills: { random: { 'api-0': 0, 'api-1': 0, worker: 0, witness: 0 }, failpoints: {} },
    exits: { killed: 0, failpoint: 0, boot: 0, crash: 0, stopped: 0 },
    crashes: [],
    starts: {},
    postgres: { kills: 0, recoveryMs: [] },
    kafka: { kills: 0, recoveryMs: [] },
    events: {},
    settlement: { days: [], outcomes: [], breaks: {} },
    anomalies: { open: 0, accepted: 0, failed: [] },
    toxics: { latency: 0, timeout: 0, reset_peer: 0, limit_data: 0, down: 0 },
    toxicsByProxy: { 'api-0-db': 0, 'api-1-db': 0, 'worker-db': 0, psp: 0, webhooks: 0, 'worker-kafka': 0, witness: 0 },
    ledger: { anomalies: {}, webhooks: {} },
    pspOperations: {},
    checks: { periodic: 0, resumed: 0, skipped: 0 },
    witness: { checkpoints: 0, size: 0, compared: 0 },
    verification: { requested: 0, runs: {}, maxAttempts: 0 },
    harnessErrors: [],
    violations,
  }
}

export function summarizePayments(reports: readonly PaymentsReport[]) {
  const sum = (f: (r: PaymentsReport) => number) => reports.reduce((total, r) => total + f(r), 0)
  const merged = (f: (r: PaymentsReport) => Record<string, number>) => {
    const into: Record<string, number> = {}
    for (const r of reports) addCounts(into, f(r))
    return into
  }
  const firstViolation = reports.findIndex((r) => r.violations.length > 0)
  return {
    runs: reports.length,
    journeys: sum((r) => r.journeys),
    payouts: sum((r) => r.payouts),
    outcomes: merged((r) => r.outcomes),
    payoutOutcomes: merged((r) => r.payoutOutcomes),
    requests: sum((r) => r.requests),
    sends: sum((r) => r.sends),
    duplicates: sum((r) => r.duplicates),
    probes: sum((r) => r.probes),
    answers: merged((r) => r.answers),
    surprises: sum((r) => r.surprises.count),
    forged: merged((r) => r.forged),
    randomKills: merged((r) => r.kills.random),
    failpointKills: merged((r) => r.kills.failpoints),
    exits: merged((r) => r.exits),
    starts: merged((r) => r.starts),
    postgresKills: sum((r) => r.postgres.kills),
    postgresRecoveryMsMedian: median(reports.flatMap((r) => r.postgres.recoveryMs)),
    kafkaKills: sum((r) => r.kafka.kills),
    settlementBreaks: merged((r) => r.settlement.breaks),
    kafkaRecoveryMsMedian: median(reports.flatMap((r) => r.kafka.recoveryMs)),
    periodicChecks: sum((r) => r.checks.periodic),
    periodicChecksResumed: sum((r) => r.checks.resumed),
    witnessCheckpoints: sum((r) => r.witness.checkpoints),
    witnessRootsCompared: sum((r) => r.witness.compared),
    verificationRequests: sum((r) => r.verification.requested),
    verificationRuns: merged((r) => r.verification.runs),
    verificationMaxAttempts: Math.max(0, ...reports.map((r) => r.verification.maxAttempts)),
    events: merged((r) => r.events),
    toxics: merged((r) => r.toxics),
    toxicsByProxy: merged((r) => r.toxicsByProxy),
    anomalies: merged((r) => r.ledger.anomalies),
    anomaliesAccepted: sum((r) => r.anomalies.accepted),
    anomaliesNotAccepted: sum((r) => r.anomalies.failed.length),
    webhooks: merged((r) => r.ledger.webhooks),
    pspOperations: merged((r) => r.pspOperations),
    settleMsMedian: median(reports.map((r) => r.settleMs)),
    settleMsMax: Math.max(...reports.map((r) => r.settleMs)),
    runsWithViolations: reports.filter((r) => r.violations.length > 0).length,
    violationsByInvariant: byInvariant(reports),
    firstViolatingRun: firstViolation === -1 ? null : firstViolation + 1,
    harnessErrors: sum((r) => r.harnessErrors.length),
  }
}

export function describePaymentsRun(index: number, r: PaymentsReport): string {
  const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0)
  const found = r.violations.length === 0 ? 'no violations' : r.violations.map((v) => `${v.id}/${v.phase} ${v.count}`).join(', ')
  return (
    `run ${index} seed ${r.seed}: ${r.journeys} journeys, ${r.payouts} payouts, ${r.requests} requests, ${r.sends} sends, ` +
    `kills ${total(r.kills.random)} random + ${total(r.kills.failpoints)} at failpoints, crashes ${r.exits.crash}, ` +
    `postgres ${r.postgres.kills}, kafka ${r.kafka.kills}, toxics ${total(r.toxics)}, surprises ${r.surprises.count}, ` +
    `witnessed ${r.witness.size} leaves in ${r.witness.checkpoints} checkpoints, ${r.witness.compared} compared by the verifier, ` +
    `settled ${r.settled ? `in ${(r.settleMs / 1000).toFixed(1)} s` : 'NOT'}, ${found}`
  )
}
