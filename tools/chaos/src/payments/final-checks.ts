import { verifyLog } from '@carwash/audit-pg'
import {
  checkAgainstPsp,
  checkAudit,
  checkEvents,
  checkLedger,
  checkPayments,
  checkPaymentsIncrementally,
  checkSequenced,
  checkSettled,
  checkSettlement,
  readWitness,
  readWitnessHistory,
  type WitnessView,
} from '@carwash/invariants'
import { inSnapshot } from '@carwash/pg'
import type { Violations } from '../violations.ts'
import { completedVerificationRun } from './admin.ts'
import { checkKeys, compareBeliefs, readState, unanswered } from './checks.ts'
import type { Clients } from './client.ts'
import type { Journeys } from './journeys.ts'
import type { PaymentsReport } from './report.ts'
import { SETTLEMENT_DAY_SECONDS, WITNESS_URL, type PaymentsStack } from './stack.ts'

export interface RunState {
  witness: WitnessView
  clients: Clients
  journeys: Journeys
}

export async function runFinalVerification(
  stack: PaymentsStack,
  report: PaymentsReport,
  found: Violations,
  askedRuns: ReadonlySet<string>,
  log: (line: string) => void,
): Promise<WitnessView> {
  const [witness, history] = await Promise.all([readWitness(WITNESS_URL), readWitnessHistory(WITNESS_URL)])
  const witnessed = witness.latest?.size ?? 0
  const checkpoints = history.filter((checkpoint) => checkpoint.size <= witnessed).length
  report.witness = { checkpoints, size: witnessed, compared: 0 }
  report.verification.requested = askedRuns.size
  const finalRun = await completedVerificationRun()
  const finalReport = finalRun?.status === 'done' ? finalRun.report : null
  found.add(
    'verify-job',
    'final',
    'a verification run in the worker, asked for once the faults stop, ends done and finds nothing',
    finalReport ? finalReport.findings : 1,
    finalReport ? finalReport.examples.slice(0, 5).map((finding) => JSON.stringify(finding)) : [JSON.stringify(finalRun)],
  )
  const { rows: runs } = await stack.owner.query<{ status: string; n: number; attempts: number }>(
    'SELECT status::text, count(*)::int AS n, max(attempts) AS attempts FROM verification_runs GROUP BY status',
  )
  report.verification.runs = Object.fromEntries(runs.map((row) => [row.status, row.n]))
  report.verification.maxAttempts = Math.max(0, ...runs.map((row) => row.attempts))
  log(`verification runs ${JSON.stringify(report.verification)}, the last one ${finalRun?.status ?? 'never finished'}`)
  return witness
}

export async function checkWhenStopped(
  stack: PaymentsStack,
  report: PaymentsReport,
  found: Violations,
  { witness, clients, journeys }: RunState,
): Promise<void> {
  const { audit, psp } = stack
  found.addResults(await checkLedger(audit), 'final')
  const full = await checkPayments(audit)
  const resumed = (await checkPaymentsIncrementally(audit)).results
  found.addResults(full, 'final')
  for (const result of full) {
    const count = resumed.find((r) => r.id === result.id)?.count
    if (count !== result.count) report.harnessErrors.push(`the incremental ${result.id} found ${String(count)}, the full one ${result.count}`)
  }
  found.addResults([await checkAgainstPsp(audit, psp), await checkSettled(audit)], 'final')
  found.addResults(await checkEvents(audit), 'final')
  found.addResults([await checkAudit(audit, witness), await checkSequenced(audit, witness)], 'final')
  const verification = await inSnapshot(audit, (client) => verifyLog(client, { witness }))
  report.witness.compared = verification.witnessed
  found.add(
    'verify',
    'final',
    "the audit verifier finds nothing against the stored copies and the witness's latest checkpoint",
    verification.findings,
    verification.examples.slice(0, 5).map((finding) => JSON.stringify(finding)),
  )
  found.addResults(
    [
      await checkSettlement(audit, {
        daySeconds: SETTLEMENT_DAY_SECONDS,
        feeBps: 120,
        feeFixed: 8,
        completeThrough: Math.max(...report.settlement.days, -1),
      }),
    ],
    'final',
  )
  const keyFindings = checkKeys(clients.records.values(), clients.probes)
  found.add('S5', 'final', 'every idempotency key answered one way, and refused a different request', keyFindings.count, keyFindings.examples)
  const state = await readState(
    audit,
    journeys.refused.map((r) => r.key),
  )
  const beliefs = compareBeliefs(journeys.payments, journeys.payouts, journeys.refused, state)
  found.add('S8', 'final', 'the ledger holds what clients were told, and every refused answer left an anomaly', beliefs.count, beliefs.examples)
  const open = unanswered(clients.records.values(), clients.probes)
  found.add('L1', 'final', 'every request has a final answer once the faults stop', open.count, open.examples)
}
