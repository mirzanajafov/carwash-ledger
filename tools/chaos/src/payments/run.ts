import { checkAgainstPsp, checkAudit, checkLedger, checkPaymentsIncrementally, readWitness } from '@carwash/invariants'
import { mulberry32 } from '@carwash/lab'
import { NO_FAULTS } from '@carwash/psp'
import { drive, startClock } from '../drive.ts'
import type { Lab } from '../lab.ts'
import { Outages } from '../outages.ts'
import type { ServiceEvents } from '../service.ts'
import { Supervisor } from '../supervisor.ts'
import { Violations } from '../violations.ts'
import { askForVerification, currentPspFaults, setPspFaults } from './admin.ts'
import { Clients } from './client.ts'
import { activity, pendingAttempts } from './activity.ts'
import { checkWhenStopped, countWhatHappened, runFinalVerification } from './final-checks.ts'
import { Forger } from './forger.ts'
import { Journeys } from './journeys.ts'
import { planPayments, type PaymentFault } from './plan.ts'
import type { PaymentsOptions } from './options.ts'
import { newPaymentsReport, type PaymentsReport } from './report.ts'
import { acceptOpenAnomalies, hasSettled, settleDays, waitForDelivery } from './settle.ts'
import { PaymentsStack, WEBHOOK_SECRET, WITNESS_URL } from './stack.ts'

const SETTLED_EVERY_MS = 500

export async function runPayments(lab: Lab, options: PaymentsOptions, seed: number): Promise<PaymentsReport> {
  const { postgres } = lab
  const log = (line: string) => lab.log(`seed ${seed} ${line}`)
  const plan = planPayments({ ...options, seed })
  const random = mulberry32(seed ^ 0x636c69)
  const found = new Violations()
  const report = newPaymentsReport(seed, options.durationMs, plan, found.list)
  const supervisor = new Supervisor()
  const stack = await PaymentsStack.create(lab, options, seed, log)
  try {
    const { audit, psp } = stack
    const events: ServiceEvents = {
      failpoint: (_service, name) => {
        report.kills.failpoints[name] = (report.kills.failpoints[name] ?? 0) + 1
      },
      log,
      exit: (service, kind, detail) => {
        report.exits[kind]++
        log(`${service.name} exited (${kind}, ${detail})`)
        if (kind === 'crash' && report.crashes.length < 20) report.crashes.push(`${service.name} ${detail}`)
        if (kind === 'boot') supervisor.restartAfterFailedBoot(service)
        else if (kind !== 'stopped') supervisor.restart(service)
      },
    }
    await stack.start(events)

    const endpoints = stack.endpoints()
    const clients = new Clients(endpoints, stack.keys, random, log)
    log(`psp faults ${await currentPspFaults()}`)
    const merchants = Array.from({ length: options.merchants }, (_, i) => `wash_${i}`)
    for (const code of merchants) {
      const created = await clients.send(clients.record('admin', 'merchant', '/v1/merchants', { code, name: `Wash ${code}`, currency: 'EUR' }))
      if (created?.status !== 200) throw new Error(`could not create merchant ${code}: ${JSON.stringify(created?.body)}`)
    }
    await postgres.checkpoint()
    const journeys = new Journeys(
      clients,
      merchants,
      Object.keys(stack.keys).filter((k) => k !== 'admin'),
    )
    const forger = new Forger(audit, endpoints, WEBHOOK_SECRET, mulberry32(seed ^ 0x77656268))

    const outages = new Outages(lab, seed, log, { withKafka: true })
    const applyFault = async (fault: PaymentFault, index: number): Promise<void> => {
      try {
        if (fault.kind === 'kill') {
          if (stack.service(fault.target).kill()) {
            report.kills.random[fault.target]++
            log(`killed ${fault.target}`)
          }
        } else if (fault.kind === 'postgres') {
          await outages.crashPostgres(fault.downMs, report.postgres)
        } else if (fault.kind === 'kafka') {
          await outages.crashKafka(fault.downMs, report.kafka)
        } else {
          report.toxics[fault.toxic]++
          report.toxicsByProxy[fault.proxy]++
          await outages.holdToxic(fault.proxy, fault.toxic, fault.lastsMs, index)
        }
      } catch (error) {
        report.harnessErrors.push(`${fault.kind} at ${fault.at} ms: ${String(error)}`)
      }
    }

    const askedRuns = new Set<string>()
    const periodicCheck = async () => {
      void askForVerification().then((asked) => {
        if (asked) askedRuns.add(asked.id)
      })
      log(`in flight ${JSON.stringify(Object.fromEntries(clients.inFlight))}; ${await activity(postgres.adminUrl, stack.ledgerDb.name)}`)
      try {
        found.addResults(await checkLedger(audit), 'during')
        const payments = await checkPaymentsIncrementally(audit)
        found.addResults(payments.results, 'during')
        if (payments.since) report.checks.resumed++
        found.addResults([await checkAgainstPsp(audit, psp)], 'during')
        found.addResults([await checkAudit(audit, await readWitness(WITNESS_URL).catch(() => undefined))], 'during')
        report.checks.periodic++
      } catch {
        report.checks.skipped++
      }
    }

    const tasks: Promise<unknown>[] = []
    const track = (task: Promise<unknown>) =>
      tasks.push(task.catch((error: unknown) => report.harnessErrors.push(`task: ${error instanceof Error ? (error.stack ?? String(error)) : String(error)}`)))
    let nextJourney = 0
    let nextPayout = 0
    let nextFault = 0
    let nextForgery = 0
    const driven = await drive(
      startClock(),
      { durationMs: options.durationMs, settleMs: options.settleMs, checkEveryMs: options.checkEveryMs, settledEveryMs: SETTLED_EVERY_MS },
      {
        startDue: (t) => {
          for (let journey = plan.journeys[nextJourney]; journey !== undefined && journey.at <= t; journey = plan.journeys[++nextJourney])
            track(journeys.payment(journey))
          for (let payout = plan.payouts[nextPayout]; payout !== undefined && payout.at <= t; payout = plan.payouts[++nextPayout])
            track(journeys.payout(payout))
          for (let at = plan.forgeries[nextForgery]; at !== undefined && at <= t; at = plan.forgeries[++nextForgery]) track(forger.forge())
          for (let fault = plan.faults[nextFault]; fault !== undefined && fault.at <= t; fault = plan.faults[++nextFault])
            outages.track(applyFault(fault, nextFault))
        },
        endFaults: async () => {
          await outages.end()
          for (const service of stack.services) {
            service.disarm()
            service.start()
          }
          await setPspFaults(NO_FAULTS)
          log('faults stopped, settling')
        },
        canCheck: () => outages.postgresUp,
        check: periodicCheck,
        settled: async (settlingMs) => {
          const done = await hasSettled(tasks, journeys.probes, audit)
          if (Math.floor(settlingMs / 5000) !== Math.floor((settlingMs - SETTLED_EVERY_MS) / 5000)) {
            log(`settling: ${clients.unanswered()} requests open, ${await pendingAttempts(audit)} attempts pending`)
            log(`in flight ${JSON.stringify(Object.fromEntries(clients.inFlight))}; ${await activity(postgres.adminUrl, stack.ledgerDb.name)}`)
          }
          return done
        },
      },
    )
    report.settleMs = driven.settleMs
    report.settled = driven.settled
    await acceptOpenAnomalies(report, journeys, log)
    await settleDays(report, log)
    await waitForDelivery(audit)
    clients.stop()
    await Promise.allSettled([...tasks, ...journeys.probes])
    const witness = await runFinalVerification(stack, report, found, askedRuns, log)

    supervisor.stopRestarting()
    await stack.stopServices()
    await driven.lastCheck

    await checkWhenStopped(stack, report, found, { witness, clients, journeys })
    Object.assign(report, await countWhatHappened(stack, lab, { clients, journeys, forger }))
    return report
  } finally {
    supervisor.stopRestarting()
    await stack.close()
  }
}
