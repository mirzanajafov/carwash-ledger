import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { FAILPOINTS } from '@carwash/failpoints'
import { checkLedger } from '@carwash/invariants'
import { createAccount, type Account, type BalanceMode } from '@carwash/ledger'
import { createTestDatabase } from '@carwash/testkit'
import { fetchJournals } from './checks.ts'
import { ClientLedger, type Op } from './client.ts'
import { compareWithClient, unsettled } from './compare.ts'
import type { EntrySpec, FromWorker, Outcome } from './messages.ts'
import { crashPostgres, holdToxic } from './outages.ts'
import { fee, planRun, type Fault, type Journey, type ToxicKind } from './plan.ts'
import type { LocalPostgres } from './postgres.ts'
import { mulberry32 } from './random.ts'
import type { Toxiproxy } from './toxiproxy.ts'
import { addCounts, byInvariant, median, Violations, type Violation } from './violations.ts'
import { Worker, type WorkerEvents } from './workers.ts'
import type { LocalKafka } from './kafka.ts'

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

export interface Lab {
  dir: string
  postgres: LocalPostgres
  kafka: LocalKafka
  toxiproxy: Toxiproxy
  log(line: string): void
}

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

const POSTGRES_PORT = 5432
const PROXY_PORTS = { posters: 6432, snapshots: 6433 } as const

function withPort(url: string, port: number): string {
  const parsed = new URL(url)
  parsed.port = String(port)
  return parsed.toString()
}

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

export async function runLedger(lab: Lab, options: LedgerOptions, seed: number): Promise<LedgerReport> {
  const { postgres, toxiproxy } = lab
  const log = (line: string) => lab.log(`seed ${seed} ${line}`)
  const failpointSpec = (prefix: string) =>
    FAILPOINTS.filter((name) => name.startsWith(prefix))
      .map((name) => `${name}=${options.failpointProbability}`)
      .join(',')
  const plan = planRun({ ...options, seed })
  const random = mulberry32(seed ^ 0x72756e)
  const found = new Violations()
  const report: LedgerReport = {
    seed,
    startedAt: new Date().toISOString(),
    faultPhaseMs: options.durationMs,
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
    violations: found.list,
  }

  const db = await createTestDatabase()
  const workers: Worker[] = []
  let stopping = false
  try {
    const app = db.pool('ledger_app', 2)
    const audit = db.pool('ledger_audit', 1)
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

    await toxiproxy.reset()
    await toxiproxy.replaceProxy('posters', PROXY_PORTS.posters, POSTGRES_PORT)
    await toxiproxy.replaceProxy('snapshots', PROXY_PORTS.snapshots, POSTGRES_PORT)

    const client = new ClientLedger(random)
    const journeys = new Map(plan.journeys.map((j) => [j.ref, j]))
    const started = performance.now()
    const now = () => performance.now() - started

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
        if (stopping) return
        if (signal === null && code !== 0) report.crashes++
        setTimeout(() => {
          if (!stopping) worker.start()
        }, 500)
      },
    }
    const script = (name: string) => fileURLToPath(new URL(`./${name}.ts`, import.meta.url))
    const posterUrl = withPort(db.url('ledger_app'), PROXY_PORTS.posters)
    const posters = Array.from(
      { length: options.posters },
      (_, i) =>
        new Worker(
          'poster',
          i,
          script('poster'),
          { CHAOS_DB_URL: posterUrl, CHAOS_POOL: String(options.pool), CHAOS_FAILPOINTS: failpointSpec('post.') },
          events,
        ),
    )
    const snapshotter = new Worker(
      'snapshotter',
      0,
      script('snapshotter'),
      {
        CHAOS_DB_URL: withPort(db.url('ledger_app'), PROXY_PORTS.snapshots),
        CHAOS_SNAPSHOT_MS: String(options.snapshotMs),
        CHAOS_FAILPOINTS: failpointSpec('snapshot.'),
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

    const busy = { postgres: false }
    let toxicCount = 0
    const applyFault = async (fault: Fault, index: number): Promise<void> => {
      try {
        if (fault.kind === 'kill') {
          const worker = fault.worker === 'snapshotter' ? snapshotter : posters[fault.index % posters.length]
          if (worker === undefined) throw new Error(`there is no poster ${fault.index % posters.length}`)
          if (!worker.alive) return
          worker.kill()
          report.kills.random++
        } else if (fault.kind === 'postgres') {
          if (busy.postgres) return
          busy.postgres = true
          try {
            report.postgres.kills++
            report.postgres.recoveryMs.push(await crashPostgres(postgres, fault.downMs))
          } finally {
            busy.postgres = false
          }
        } else {
          report.toxics[fault.toxic]++
          await holdToxic(toxiproxy, fault.proxy, fault.toxic, fault.lastsMs, `${fault.toxic}-${toxicCount++}`, mulberry32(seed * 7919 + index))
        }
      } catch (error) {
        report.harnessErrors.push(`${fault.kind} at ${fault.at} ms: ${String(error)}`)
      }
    }

    let checking = false
    const periodicCheck = async () => {
      try {
        found.addResults(await checkLedger(audit), 'during')
        report.checks.periodic++
      } catch {
        report.checks.skipped++
      } finally {
        checking = false
      }
    }

    const faultTasks: Promise<void>[] = []
    let nextJourney = 0
    let nextFault = 0
    let lastCheck = 0
    let lastSettleCheck = 0
    let settleStarted: number | undefined
    for (;;) {
      const t = now()
      if (settleStarted === undefined) {
        for (let journey = plan.journeys[nextJourney]; journey !== undefined && journey.at <= t; journey = plan.journeys[++nextJourney]) {
          client.add({ ref: journey.ref, kind: 'capture', entries: captureEntries(journey, receivable, fees, merchants), retryAt: t })
          report.captures++
        }
        for (let fault = plan.faults[nextFault]; fault !== undefined && fault.at <= t; fault = plan.faults[++nextFault])
          faultTasks.push(applyFault(fault, nextFault))
        if (t >= options.durationMs) {
          await Promise.all(faultTasks)
          await toxiproxy.reset()
          if (!postgres.running) {
            postgres.start()
            await postgres.waitReady()
          }
          for (const worker of workers) {
            worker.disarm()
            worker.start()
          }
          settleStarted = now()
        }
      }
      for (const op of client.due(t)) dispatch(op)
      if (!checking && postgres.running && !busy.postgres && t - lastCheck >= options.checkEveryMs) {
        lastCheck = t
        checking = true
        void periodicCheck()
      }
      if (settleStarted !== undefined && t - lastSettleCheck >= 50) {
        lastSettleCheck = t
        if (client.inFlight() === 0 && client.unresolved().length === 0) break
        if (t - settleStarted > options.settleMs) {
          report.settled = false
          break
        }
      }
      await sleep(5)
    }
    report.settleMs = Math.round(now() - settleStarted)
    report.outcomes = { ...client.stats }

    stopping = true
    await Promise.all(workers.map((w) => w.stop()))
    report.workerStarts = workers.reduce((sum, w) => sum + w.starts, 0)
    while (checking) await sleep(10)

    found.addResults(await checkLedger(audit), 'final')
    const ledger = compareWithClient(client.ops.values(), await fetchJournals(audit))
    found.add('S8', 'final', 'the ledger holds exactly the journals clients were told about', ledger.count, ledger.examples)
    const open = unsettled(client.ops.values())
    found.add('L1', 'final', 'every journal is resolved once the faults stop', open.count, open.examples)
    return report
  } finally {
    stopping = true
    await Promise.all(workers.map((w) => w.stop())).catch(() => undefined)
    await db.drop().catch((error: unknown) => log(`drop failed: ${String(error)}`))
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
