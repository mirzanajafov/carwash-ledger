import { fileURLToPath } from 'node:url'
import { failpointSpec } from '@carwash/failpoints'
import { checkLedger } from '@carwash/invariants'
import { mulberry32 } from '@carwash/lab'
import { createAccount, type Account, type BalanceMode } from '@carwash/ledger'
import { createTestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { fetchJournals } from './checks.ts'
import { ClientLedger, type Op } from './client.ts'
import { compareWithClient, unsettled } from './compare.ts'
import type { EntrySpec, FromWorker, Outcome } from './messages.ts'
import { drive, startClock } from './drive.ts'
import { withPort, type Lab } from './lab.ts'
import { Outages } from './outages.ts'
import { fee, planRun, type Fault, type Journey } from './plan.ts'
import { Supervisor } from './supervisor.ts'
import { newLedgerReport, type LedgerReport } from './ledger-report.ts'
import { Violations } from './violations.ts'
import { Worker, type WorkerEvents } from './workers.ts'

export interface LedgerOptions {
  durationMs: number
  rate: number
  posters: number
  pool: number
  merchants: number
  reversalShare: number
  duplicateShare: number
  killEveryMs: number
  postgresEveryMs: number
  toxicEveryMs: number
  failpointProbability: number
  snapshotMs: number
  checkEveryMs: number
  settleMs: number
  receivable: BalanceMode
  fees: BalanceMode
  shards: number
}

const POSTGRES_PORT = 5432
const PROXY_PORTS = { posters: 6432, snapshots: 6433 } as const

function captureEntries(journey: Journey, receivable: Account, fees: Account, merchants: Account[]): EntrySpec[] {
  const merchant = merchants[journey.merchant]
  if (merchant === undefined) throw new Error(`there is no merchant ${journey.merchant} for ${journey.ref}`)
  const cut = fee(journey.gross)
  return [
    { accountId: receivable.id.toString(), amount: journey.gross.toString() },
    { accountId: merchant.id.toString(), amount: (-(journey.gross - cut)).toString() },
    { accountId: fees.id.toString(), amount: (-cut).toString() },
  ]
}

async function createAccounts(app: pg.Pool, options: LedgerOptions): Promise<{ receivable: Account; fees: Account; merchants: Account[] }> {
  const receivable = await createAccount(app, {
    code: 'psp_receivable',
    type: 'asset',
    currency: 'EUR',
    balanceMode: options.receivable,
    shards: options.shards,
  })
  const fees = await createAccount(app, {
    code: 'platform_fees',
    type: 'revenue',
    currency: 'EUR',
    balanceMode: options.fees,
    shards: options.shards,
  })
  const merchants: Account[] = []
  for (let i = 0; i < options.merchants; i++) {
    merchants.push(await createAccount(app, { code: `merchant_${i}`, type: 'liability', currency: 'EUR', balanceMode: 'locked' }))
  }
  return { receivable, fees, merchants }
}

export async function runLedger(lab: Lab, options: LedgerOptions, seed: number): Promise<LedgerReport> {
  const { toxiproxy } = lab
  const log = (line: string) => lab.log(`seed ${seed} ${line}`)
  const failpoints = (prefix: string) => failpointSpec([prefix], () => options.failpointProbability)
  const plan = planRun({ ...options, seed })
  const random = mulberry32(seed ^ 0x72756e)
  const found = new Violations()
  const report = newLedgerReport(seed, options.durationMs, plan, found.list)

  const db = await createTestDatabase()
  const workers: Worker[] = []
  const supervisor = new Supervisor()
  try {
    const app = db.pool('ledger_app', 2)
    const audit = db.pool('ledger_audit', 1)
    const { receivable, fees, merchants } = await createAccounts(app, options)

    await toxiproxy.reset()
    await toxiproxy.replaceProxy('posters', PROXY_PORTS.posters, POSTGRES_PORT)
    await toxiproxy.replaceProxy('snapshots', PROXY_PORTS.snapshots, POSTGRES_PORT)

    const client = new ClientLedger(random)
    const journeys = new Map(plan.journeys.map((j) => [j.ref, j]))
    const now = startClock()

    const events: WorkerEvents = {
      outcome: (ref: string, outcome: Outcome) => {
        if (client.record(ref, outcome, now()) !== 'acknowledged') return
        const op = client.ops.get(ref)
        if (op === undefined) throw new Error(`op ${ref} was acknowledged but the client ledger has no such op`)
        if (op.kind !== 'capture' || !journeys.get(ref)?.reverse) return
        client.add({
          ref: `rev:${ref}`,
          kind: 'reversal',
          entries: op.entries.map((e) => ({ accountId: e.accountId, amount: (-BigInt(e.amount)).toString() })),
          reversesRef: ref,
          reversesId: op.journalId,
          retryAt: now() + Math.floor(random() * 500),
        })
        report.reversals++
      },
      failpoint: (name: string) => {
        report.kills.failpoints[name] = (report.kills.failpoints[name] ?? 0) + 1
      },
      message: (message: FromWorker) => {
        if (message.type === 'snapshot') report.snapshots.taken++
        else if (message.type === 'snapshot-error') report.snapshots.errors++
      },
      log,
      exit: (worker: Worker, code: number | null, signal: NodeJS.Signals | null) => {
        if (supervisor.stopped) return
        if (signal === null && code !== 0) report.crashes++
        supervisor.restart(worker)
      },
    }
    const script = (name: string) => fileURLToPath(new URL(`./${name}.ts`, import.meta.url))
    const posterUrl = withPort(db.url('ledger_app'), PROXY_PORTS.posters)
    const posters = Array.from(
      { length: options.posters },
      (_, i) =>
        new Worker('poster', i, script('poster'), { CHAOS_DB_URL: posterUrl, CHAOS_POOL: String(options.pool), CHAOS_FAILPOINTS: failpoints('post.') }, events),
    )
    const snapshotter = new Worker(
      'snapshotter',
      0,
      script('snapshotter'),
      {
        CHAOS_DB_URL: withPort(db.url('ledger_app'), PROXY_PORTS.snapshots),
        CHAOS_SNAPSHOT_MS: String(options.snapshotMs),
        CHAOS_FAILPOINTS: failpoints('snapshot.'),
      },
      events,
    )
    workers.push(...posters, snapshotter)
    for (const worker of workers) worker.start()

    const capacity = options.pool * 2
    const duplicates = new Set(plan.journeys.filter((j) => j.duplicate).map((j) => j.ref))
    const dispatch = (op: Op) => {
      const alive = posters.filter((w) => w.alive && w.load < capacity).sort((a, b) => a.load - b.load)
      if (alive.length === 0) {
        client.defer(op, now() + 20)
        return
      }
      const twice = op.attempts === 0 && duplicates.has(op.ref) && alive.length >= 2
      for (const worker of twice ? alive.slice(0, 2) : alive.slice(0, 1)) {
        client.dispatched(op)
        report.attempts++
        worker.post(op.ref, op.entries, op.reversesId)
      }
    }

    const outages = new Outages(lab, seed, log)
    const applyFault = async (fault: Fault, index: number): Promise<void> => {
      try {
        if (fault.kind === 'kill') {
          const worker = fault.worker === 'snapshotter' ? snapshotter : posters[fault.index % posters.length]
          if (worker === undefined) throw new Error(`there is no poster ${fault.index % posters.length}`)
          if (!worker.alive) return
          worker.kill()
          report.kills.random++
        } else if (fault.kind === 'postgres') {
          await outages.crashPostgres(fault.downMs, report.postgres)
        } else {
          report.toxics[fault.toxic]++
          await outages.holdToxic(fault.proxy, fault.toxic, fault.lastsMs, index)
        }
      } catch (error) {
        report.harnessErrors.push(`${fault.kind} at ${fault.at} ms: ${String(error)}`)
      }
    }

    const periodicCheck = async () => {
      try {
        found.addResults(await checkLedger(audit), 'during')
        report.checks.periodic++
      } catch {
        report.checks.skipped++
      }
    }

    let nextJourney = 0
    let nextFault = 0
    const driven = await drive(
      now,
      { durationMs: options.durationMs, settleMs: options.settleMs, checkEveryMs: options.checkEveryMs, settledEveryMs: 50 },
      {
        startDue: (t) => {
          for (let journey = plan.journeys[nextJourney]; journey !== undefined && journey.at <= t; journey = plan.journeys[++nextJourney]) {
            client.add({ ref: journey.ref, kind: 'capture', entries: captureEntries(journey, receivable, fees, merchants), retryAt: t })
            report.captures++
          }
          for (let fault = plan.faults[nextFault]; fault !== undefined && fault.at <= t; fault = plan.faults[++nextFault])
            outages.track(applyFault(fault, nextFault))
        },
        endFaults: async () => {
          await outages.end()
          for (const worker of workers) {
            worker.disarm()
            worker.start()
          }
        },
        tick: (t) => {
          for (const op of client.due(t)) dispatch(op)
        },
        canCheck: () => outages.postgresUp,
        check: periodicCheck,
        settled: () => Promise.resolve(client.inFlight() === 0 && client.unresolved().length === 0),
      },
    )
    report.settleMs = driven.settleMs
    report.settled = driven.settled
    report.outcomes = { ...client.stats }

    supervisor.stopRestarting()
    await Promise.all(workers.map((w) => w.stop()))
    report.workerStarts = workers.reduce((sum, w) => sum + w.starts, 0)
    await driven.lastCheck
    report.harnessErrors.push(...driven.checkErrors.map((error) => `check: ${String(error)}`))

    found.addResults(await checkLedger(audit), 'final')
    const ledger = compareWithClient(client.ops.values(), await fetchJournals(audit))
    found.add('S8', 'final', 'the ledger holds exactly the journals clients were told about', ledger.count, ledger.examples)
    const open = unsettled(client.ops.values())
    found.add('L1', 'final', 'every journal is resolved once the faults stop', open.count, open.examples)
    return report
  } finally {
    supervisor.stopRestarting()
    await Promise.all(workers.map((w) => w.stop())).catch(() => undefined)
    await db.drop().catch((error: unknown) => log(`drop failed: ${String(error)}`))
  }
}
