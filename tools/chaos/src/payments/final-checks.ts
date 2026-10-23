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
  type WitnessView,
} from '@carwash/invariants'
import { firstRow, inSnapshot } from '@carwash/pg'
import type { Lab } from '../lab.ts'
import type { Violations } from '../violations.ts'
import { checkKeys, compareBeliefs, readState, unanswered } from './checks.ts'
import type { Clients } from './client.ts'
import { countBy, publishedMessages } from './diagnostics.ts'
import type { Forger } from './forger.ts'
import type { Journeys } from './journeys.ts'
import type { PaymentsReport } from './report.ts'
import { SETTLEMENT_DAY_SECONDS, type PaymentsStack } from './stack.ts'

export interface Run {
  witness: WitnessView
  clients: Clients
  journeys: Journeys
}

export async function checkWhenStopped(stack: PaymentsStack, report: PaymentsReport, found: Violations, { witness, clients, journeys }: Run): Promise<void> {
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

export async function countWhatHappened(
  stack: PaymentsStack,
  lab: Lab,
  { clients, journeys, forger }: { clients: Clients; journeys: Journeys; forger: Forger },
): Promise<Partial<PaymentsReport>> {
  const { audit, psp } = stack
  return {
    outcomes: journeys.outcomes,
    payoutOutcomes: journeys.payoutOutcomes,
    requests: clients.stats.requests,
    sends: clients.stats.sends,
    duplicates: clients.stats.duplicates,
    probes: clients.probes.length,
    answers: clients.stats.answers,
    surprises: journeys.surprises,
    forged: forger.outcomes,
    starts: Object.fromEntries(stack.services.map((s) => [s.name, s.starts])),
    ledger: {
      anomalies: await countBy(audit, 'SELECT kind AS name, count(*)::int AS n FROM anomalies GROUP BY kind'),
      webhooks: await countBy(audit, 'SELECT outcome AS name, count(*)::int AS n FROM webhook_events GROUP BY outcome'),
    },
    pspOperations: await countBy(psp, `SELECT kind || ' ' || status AS name, count(*)::int AS n FROM operations GROUP BY 1`),
    events: {
      ...(await countBy(audit, `SELECT 'outbox ' || topic AS name, count(*)::int AS n FROM outbox GROUP BY topic`)),
      ...(await countBy(audit, `SELECT 'inbox ' || consumer AS name, count(*)::int AS n FROM inbox GROUP BY consumer`)),
      receipts: firstRow(await audit.query<{ n: number }>('SELECT count(*)::int AS n FROM receipts')).n,
      ...(await publishedMessages(lab.kafka.directBroker)),
    },
  }
}
