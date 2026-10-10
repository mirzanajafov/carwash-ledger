import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkLedger, violations, type InvariantResult } from '@carwash/invariants'
import { createAccount, FAILPOINTS, type Account, type BalanceMode } from '@carwash/ledger'
import { createTestDatabase, prepareTemplate } from '@carwash/testkit'
import { fetchJournals } from './checks.ts'
import { ClientLedger, type Op } from './client.ts'
import { compareWithClient, unsettled } from './compare.ts'
import type { EntrySpec, FromWorker, Outcome } from './messages.ts'
import { fee, planRun, TOXIC_KINDS, type Fault, type Journey } from './plan.ts'
import { createRoles, LocalPostgres } from './postgres.ts'
import { mulberry32 } from './random.ts'
import { appendJsonLine, createResultsDir, writeJson } from './results.ts'
import { toxicFor, Toxiproxy } from './toxiproxy.ts'
import { Worker, type WorkerEvents } from './workers.ts'

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '5' },
    seed: { type: 'string', default: '1' },
    duration: { type: 'string', default: '60' },
    rate: { type: 'string', default: '150' },
    posters: { type: 'string', default: '4' },
    pool: { type: 'string', default: '8' },
    merchants: { type: 'string', default: '20' },
    reversals: { type: 'string', default: '0.2' },
    duplicates: { type: 'string', default: '0.05' },
    'kill-every': { type: 'string', default: '3000' },
    'postgres-every': { type: 'string', default: '20000' },
    'toxic-every': { type: 'string', default: '4000' },
    failpoints: { type: 'string', default: '0.001' },
    'snapshot-ms': { type: 'string', default: '100' },
    'check-every': { type: 'string', default: '5000' },
    settle: { type: 'string', default: '120' },
    receivable: { type: 'string', default: 'sharded' },
    fees: { type: 'string', default: 'derived' },
    shards: { type: 'string', default: '16' },
    'until-violation': { type: 'boolean', default: false },
    out: { type: 'string', default: fileURLToPath(new URL('../results', import.meta.url)) },
  },
})

const options = {
  runs: Number(values.runs),
  seed: Number(values.seed),
  durationMs: Number(values.duration) * 1000,
  rate: Number(values.rate),
  posters: Number(values.posters),
  pool: Number(values.pool),
  merchants: Number(values.merchants),
  reversalShare: Number(values.reversals),
  duplicateShare: Number(values.duplicates),
  killEveryMs: Number(values['kill-every']),
  postgresEveryMs: Number(values['postgres-every']),
  toxicEveryMs: Number(values['toxic-every']),
  failpointProbability: Number(values.failpoints),
  snapshotMs: Number(values['snapshot-ms']),
  checkEveryMs: Number(values['check-every']),
  settleMs: Number(values.settle) * 1000,
  receivable: values.receivable as BalanceMode,
  fees: values.fees as BalanceMode,
  shards: Number(values.shards),
  untilViolation: values['until-violation'],
}

const POSTGRES_PORT = 5432
const PROXY_PORTS = { posters: 6432, snapshots: 6433 } as const
let logFile = '/tmp/harness.log'
const mutant = process.env.MUTANT ?? ''

interface Violation {
  id: string
  phase: 'during' | 'final'
  description: string
  count: number
  examples: string[]
}

interface RunReport {
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
  toxics: Record<string, number>
  snapshots: { taken: number; errors: number }
  checks: { periodic: number; skipped: number }
  harnessErrors: string[]
  violations: Violation[]
}

let postgres: LocalPostgres
const toxiproxy = new Toxiproxy()

function log(line: string): void {
  appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
}

function withPort(url: string, port: number): string {
  const parsed = new URL(url)
  parsed.port = String(port)
  return parsed.toString()
}

function captureEntries(journey: Journey, receivable: Account, fees: Account, merchants: Account[]): EntrySpec[] {
  const cut = fee(journey.gross)
  return [
    { accountId: receivable.id.toString(), amount: journey.gross.toString() },
    { accountId: merchants[journey.merchant]!.id.toString(), amount: (-(journey.gross - cut)).toString() },
    { accountId: fees.id.toString(), amount: (-cut).toString() },
  ]
}

function failpointSpec(prefix: string): string {
  return FAILPOINTS.filter((name) => name.startsWith(prefix))
    .map((name) => `${name}=${options.failpointProbability}`)
    .join(',')
}

async function runOne(seed: number): Promise<RunReport> {
  const plan = planRun({ ...options, seed })
  const random = mulberry32(seed ^ 0x72756e)
  const report: RunReport = {
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
    toxics: Object.fromEntries(TOXIC_KINDS.map((k) => [k, 0])),
    snapshots: { taken: 0, errors: 0 },
    checks: { periodic: 0, skipped: 0 },
    harnessErrors: [],
    violations: [],
  }
  const addViolation = (id: string, phase: Violation['phase'], description: string, count: number, examples: string[]) => {
    const existing = report.violations.find((v) => v.id === id && v.phase === phase)
    if (existing === undefined) report.violations.push({ id, phase, description, count, examples })
    else existing.count = Math.max(existing.count, count)
  }
  const addResults = (results: readonly InvariantResult[], phase: Violation['phase']) => {
    for (const r of violations(results)) addViolation(r.id, phase, r.description, r.count, r.examples)
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
        const op = client.ops.get(ref)!
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
      log: (line: string) => log(`seed ${seed} ${line}`),
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

    let postgresBusy = false
    let toxicCount = 0
    const applyFault = async (fault: Fault, index: number): Promise<void> => {
      try {
        if (fault.kind === 'kill') {
          const worker = fault.worker === 'snapshotter' ? snapshotter : posters[fault.index % posters.length]!
          if (!worker.alive) return
          worker.kill()
          report.kills.random++
        } else if (fault.kind === 'postgres') {
          if (postgresBusy) return
          postgresBusy = true
          try {
            report.postgres.kills++
            await postgres.kill()
            await sleep(fault.downMs)
            postgres.start()
            report.postgres.recoveryMs.push(Math.round(await postgres.waitReady()))
          } finally {
            postgresBusy = false
          }
        } else {
          report.toxics[fault.toxic]!++
          if (fault.toxic === 'down') {
            await toxiproxy.setEnabled(fault.proxy, false)
            await sleep(fault.lastsMs)
            await toxiproxy.setEnabled(fault.proxy, true)
          } else {
            const name = `${fault.toxic}-${toxicCount++}`
            await toxiproxy.addToxic(fault.proxy, toxicFor(fault.toxic, name, mulberry32(seed * 7919 + index)))
            await sleep(fault.lastsMs)
            await toxiproxy.removeToxic(fault.proxy, name)
          }
        }
      } catch (error) {
        report.harnessErrors.push(`${fault.kind} at ${fault.at} ms: ${String(error)}`)
      }
    }

    let checking = false
    const periodicCheck = async () => {
      try {
        addResults(await checkLedger(audit), 'during')
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
        while (nextJourney < plan.journeys.length && plan.journeys[nextJourney]!.at <= t) {
          const journey = plan.journeys[nextJourney++]!
          client.add({ ref: journey.ref, kind: 'capture', entries: captureEntries(journey, receivable, fees, merchants), retryAt: t })
          report.captures++
        }
        while (nextFault < plan.faults.length && plan.faults[nextFault]!.at <= t) {
          faultTasks.push(applyFault(plan.faults[nextFault]!, nextFault))
          nextFault++
        }
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
      if (!checking && postgres.running && !postgresBusy && t - lastCheck >= options.checkEveryMs) {
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
    report.settleMs = Math.round(now() - settleStarted!)
    report.outcomes = { ...client.stats }

    stopping = true
    await Promise.all(workers.map((w) => w.stop()))
    report.workerStarts = workers.reduce((sum, w) => sum + w.starts, 0)
    while (checking) await sleep(10)

    addResults(await checkLedger(audit), 'final')
    const ledger = compareWithClient(client.ops.values(), await fetchJournals(audit))
    if (ledger.count > 0) {
      addViolation('S8', 'final', 'the ledger holds exactly the journals clients were told about', ledger.count, ledger.examples)
    }
    const open = unsettled(client.ops.values())
    if (open.count > 0) addViolation('L1', 'final', 'every journal is resolved once the faults stop', open.count, open.examples)
    return report
  } finally {
    stopping = true
    await Promise.all(workers.map((w) => w.stop())).catch(() => undefined)
    await db.drop().catch((error) => log(`drop failed: ${String(error)}`))
  }
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted.length === 0 ? Number.NaN : sorted[Math.floor(sorted.length / 2)]!
}

function summarize(reports: readonly RunReport[]) {
  const sum = (f: (r: RunReport) => number) => reports.reduce((total, r) => total + f(r), 0)
  const failpoints: Record<string, number> = {}
  const toxics: Record<string, number> = {}
  const byInvariant: Record<string, { runs: number; count: number }> = {}
  for (const r of reports) {
    for (const [name, n] of Object.entries(r.kills.failpoints)) failpoints[name] = (failpoints[name] ?? 0) + n
    for (const [name, n] of Object.entries(r.toxics)) toxics[name] = (toxics[name] ?? 0) + n
    for (const id of new Set(r.violations.map((v) => v.id))) {
      const count = Math.max(...r.violations.filter((v) => v.id === id).map((v) => v.count))
      byInvariant[id] = { runs: (byInvariant[id]?.runs ?? 0) + 1, count: (byInvariant[id]?.count ?? 0) + count }
    }
  }
  const firstViolation = reports.findIndex((r) => r.violations.length > 0)
  return {
    mutant: mutant === '' ? null : mutant,
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
    violationsByInvariant: byInvariant,
    firstViolatingRun: firstViolation === -1 ? null : firstViolation + 1,
    harnessErrors: sum((r) => r.harnessErrors.length),
  }
}

function describeRun(index: number, r: RunReport): string {
  const failpointKills = Object.values(r.kills.failpoints).reduce((a, b) => a + b, 0)
  const toxics = Object.values(r.toxics).reduce((a, b) => a + b, 0)
  const found =
    r.violations.length === 0 ? 'no violations' : r.violations.map((v) => `${v.id}/${v.phase} ${v.count}`).join(', ')
  return (
    `run ${index} seed ${r.seed}: ${r.captures + r.reversals} journeys, ${r.attempts} attempts, ` +
    `kills ${r.kills.random} random + ${failpointKills} at failpoints, crashes ${r.crashes}, postgres ${r.postgres.kills}, toxics ${toxics}, ` +
    `settled ${r.settled ? `in ${(r.settleMs / 1000).toFixed(1)} s` : 'NOT'}, ${found}`
  )
}

async function main(): Promise<void> {
  const dir = createResultsDir(values.out, mutant)
  logFile = join(dir, 'harness.log')
  postgres = new LocalPostgres('/tmp/pgdata', POSTGRES_PORT, join(dir, 'postgres.log'))
  postgres.init()
  postgres.start()
  await postgres.waitReady()
  await createRoles(postgres.adminUrl)
  await prepareTemplate()
  toxiproxy.start()
  await toxiproxy.waitReady()

  writeJson(join(dir, 'run.json'), {
    commit: process.env.GIT_COMMIT ?? 'unknown',
    mutant: mutant === '' ? null : mutant,
    node: process.version,
    options,
  })
  console.log(`writing to ${dir}${mutant === '' ? '' : `, mutant ${mutant}`}`)
  const reports: RunReport[] = []
  try {
    for (let i = 0; i < options.runs; i++) {
      const report = await runOne(options.seed + i)
      reports.push(report)
      appendJsonLine(join(dir, 'runs.jsonl'), report)
      console.log(describeRun(i + 1, report))
      for (const v of report.violations) for (const example of v.examples) console.log(`  ${v.id}: ${example}`)
      if (options.untilViolation && report.violations.length > 0) break
    }
  } finally {
    toxiproxy.stop()
    await postgres.stop()
  }
  const summary = summarize(reports)
  writeJson(join(dir, 'summary.json'), summary)
  console.log(JSON.stringify(summary, null, 2))
}

await main()
