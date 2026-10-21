import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { createGzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { FAILPOINTS } from '@carwash/failpoints'
import { createPool } from '@carwash/pg'
import {
  checkAgainstPsp,
  checkAudit,
  checkEvents,
  checkLedger,
  checkPayments,
  checkSequenced,
  checkSettled,
  checkSettlement,
  readWitness,
} from '@carwash/invariants'
import { kafkaClient } from '@carwash/outbox'
import { createScratchDatabase, createTestDatabase } from '@carwash/testkit'
import pg from 'pg'
import type { Lab } from '../ledger-run.ts'
import { crashKafka, crashPostgres, holdToxic } from '../outages.ts'
import { TOXIC_KINDS } from '../plan.ts'
import { mulberry32 } from '../random.ts'
import { Service, type ExitKind, type ServiceEvents } from '../service.ts'
import { addCounts, byInvariant, median, Violations, type Violation } from '../violations.ts'
import { checkKeys, compareBeliefs, readState, unanswered } from './checks.ts'
import { Clients } from './client.ts'
import { Forger } from './forger.ts'
import { Journeys } from './journeys.ts'
import { planPayments, PROXIES, SERVICES, type PaymentFault, type ProxyName } from './plan.ts'

export interface PspFaults {
  decline: number
  fail: number
  timeoutAfterCommit: number
  slow: number
  wrongAmount: number
  webhook: { duplicate: number; delay: number; reorder: number; drop: number }
}

export interface PaymentsOptions {
  durationMs: number
  rate: number
  clients: number
  merchants: number
  manualShare: number
  cancelShare: number
  partialShare: number
  refundShare: number
  duplicateShare: number
  reuseShare: number
  rivalShare: number
  payoutEveryMs: number
  killEveryMs: number
  postgresEveryMs: number
  kafkaEveryMs: number
  toxicEveryMs: number
  forgeEveryMs: number
  failpointProbability: number
  checkEveryMs: number
  settleMs: number
  leaseSeconds: number
  pspTimeoutMs: number
  psp: PspFaults
}

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
  kills: { random: Record<string, number>; failpoints: Record<string, number> }
  exits: Record<ExitKind, number>
  crashes: string[]
  starts: Record<string, number>
  postgres: { kills: number; recoveryMs: number[] }
  kafka: { kills: number; recoveryMs: number[] }
  events: Record<string, number>
  settlement: { days: number[]; outcomes: string[]; breaks: Record<string, number> }
  anomalies: { open: number; accepted: number; failed: string[] }
  toxics: Record<string, number>
  toxicsByProxy: Record<string, number>
  ledger: { anomalies: Record<string, number>; webhooks: Record<string, number> }
  pspOperations: Record<string, number>
  checks: { periodic: number; skipped: number }
  witness: { checkpoints: number; size: number }
  harnessErrors: string[]
  violations: Violation[]
}

const ROOT = new URL('../../../../', import.meta.url)
const API_MAIN = fileURLToPath(new URL('apps/api/dist/main.js', ROOT))
const WORKER_MAIN = fileURLToPath(new URL('apps/api/dist/worker.js', ROOT))
const PSP_MAIN = fileURLToPath(new URL('apps/psp/src/main.ts', ROOT))
const WITNESS_MAIN = fileURLToPath(new URL('apps/witness/src/main.ts', ROOT))

const POSTGRES_PORT = 5432
const PSP_PORT = 3142
const API_PORTS = [3140, 3141]
const WORKER_PORT = 3144
const WITNESS_PORT = 3145
const WITNESS_URL = `http://127.0.0.1:${WITNESS_PORT}`
const KAFKA_PROXY_UPSTREAM = 9092
const PROXY_PORTS: Record<ProxyName, number> = {
  'api-0-db': 6432,
  'api-1-db': 6433,
  'worker-db': 6434,
  psp: 6440,
  webhooks: 6441,
  'worker-kafka': 6450,
  witness: 6451,
}
const PROXY_UPSTREAMS: Record<ProxyName, number> = {
  'api-0-db': POSTGRES_PORT,
  'api-1-db': POSTGRES_PORT,
  'worker-db': POSTGRES_PORT,
  psp: PSP_PORT,
  webhooks: API_PORTS[0]!,
  'worker-kafka': KAFKA_PROXY_UPSTREAM,
  witness: WITNESS_PORT,
}

const SETTLEMENT_DAY_SECONDS = 86_400
const PSP_API_KEY = 'sk_chaos_api'
const PSP_ADMIN_KEY = 'sk_chaos_admin'
const WEBHOOK_SECRET = 'whsec_chaos'
const WITNESS_TOKEN = 'witness_chaos'
const NO_FAULTS = { seed: 0, decline: 0, fail: 0, timeoutAfterCommit: 0, slow: 0, wrongAmount: 0, webhook: {} }

const API_FAILPOINTS = ['post.', 'transaction.', 'attempt.', 'request.', 'webhook.']
const WORKER_FAILPOINTS = ['post.', 'transaction.', 'attempt.', 'recovery.', 'webhook.', 'relay.', 'consumer.', 'checkpoint.']

function withPort(url: string, port: number): string {
  const parsed = new URL(url)
  parsed.port = String(port)
  return parsed.toString()
}

function failpointRate(name: string, probability: number): number {
  if (name.startsWith('transaction.')) return probability
  if (name.startsWith('checkpoint.')) return Math.min(1, probability * 200)
  return Math.min(1, probability * 4)
}

function failpointSpec(prefixes: readonly string[], probability: number): string {
  return FAILPOINTS.filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
    .map((name) => `${name}=${failpointRate(name, probability)}`)
    .join(',')
}

async function until(ready: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const started = performance.now()
  while (!ready()) {
    if (performance.now() - started > timeoutMs) throw new Error(`${what} did not get ready in ${timeoutMs} ms`)
    await sleep(50)
  }
}

async function countBy(pool: pg.Pool, sql: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ name: string; n: number }>(sql)
  return Object.fromEntries(rows.map((row) => [row.name, row.n]))
}

export async function runPayments(lab: Lab, options: PaymentsOptions, seed: number): Promise<PaymentsReport> {
  const { postgres, kafka, toxiproxy } = lab
  const log = (line: string) => lab.log(`seed ${seed} ${line}`)
  const plan = planPayments({ ...options, seed })
  const random = mulberry32(seed ^ 0x636c69)
  const found = new Violations()
  const report: PaymentsReport = {
    seed,
    startedAt: new Date().toISOString(),
    faultPhaseMs: options.durationMs,
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
    kills: { random: Object.fromEntries(SERVICES.map((s) => [s, 0])), failpoints: {} },
    exits: { killed: 0, failpoint: 0, boot: 0, crash: 0, stopped: 0 },
    crashes: [],
    starts: {},
    postgres: { kills: 0, recoveryMs: [] },
    kafka: { kills: 0, recoveryMs: [] },
    events: {},
    settlement: { days: [], outcomes: [], breaks: {} },
    anomalies: { open: 0, accepted: 0, failed: [] },
    toxics: Object.fromEntries(TOXIC_KINDS.map((k) => [k, 0])),
    toxicsByProxy: Object.fromEntries(PROXIES.map((p) => [p, 0])),
    ledger: { anomalies: {}, webhooks: {} },
    pspOperations: {},
    checks: { periodic: 0, skipped: 0 },
    witness: { checkpoints: 0, size: 0 },
    harnessErrors: [],
    violations: found.list,
  }

  const ledgerDb = await createTestDatabase()
  const pspDb = await createScratchDatabase('psp')
  const psp = createPool({ connectionString: pspDb.url, max: 2 })
  const services = new Map<string, Service>()
  const logs = `/tmp/chaos-logs/seed-${seed}`
  mkdirSync(logs, { recursive: true })
  const logFile = (name: string) => join(logs, `${name}.log`)
  const witnessDir = `/tmp/chaos-witness/seed-${seed}`
  rmSync(witnessDir, { recursive: true, force: true })
  let stopping = false
  try {
    const owner = ledgerDb.pool('ledger_owner', 1)
    const audit = ledgerDb.pool('ledger_audit', 3)
    const keys: Record<string, string> = { admin: 'cw_chaos_admin' }
    for (let i = 0; i < options.clients; i++) keys[`client-${i}`] = `cw_chaos_client_${i}`
    for (const [name, key] of Object.entries(keys)) {
      await owner.query('INSERT INTO api_clients (name, key_hash, scope) VALUES ($1, $2, $3::client_scope)', [
        name,
        createHash('sha256').update(key).digest(),
        name === 'admin' ? 'admin' : 'client',
      ])
    }

    kafka.fresh(logFile('kafka'))
    kafka.start()
    await kafka.waitReady()

    await toxiproxy.reset()
    for (const proxy of PROXIES) await toxiproxy.replaceProxy(proxy, PROXY_PORTS[proxy], PROXY_UPSTREAMS[proxy])

    const bootStreaks = new Map<Service, number>()
    const events: ServiceEvents = {
      failpoint: (_service, name) => {
        report.kills.failpoints[name] = (report.kills.failpoints[name] ?? 0) + 1
      },
      log,
      exit: (service, kind, detail) => {
        report.exits[kind]++
        log(`${service.name} exited (${kind}, ${detail})`)
        if (kind === 'crash' && report.crashes.length < 20) report.crashes.push(`${service.name} ${detail}`)
        if (stopping || kind === 'stopped') return
        const streak = kind === 'boot' ? (bootStreaks.get(service) ?? 0) + 1 : 0
        bootStreaks.set(service, streak)
        setTimeout(
          () => {
            if (!stopping) service.start()
          },
          Math.min(4000, 500 * 2 ** streak),
        )
      },
    }
    const ledgerUrl = (proxy: ProxyName) => withPort(ledgerDb.url('ledger_app'), PROXY_PORTS[proxy])
    const shared = {
      PSP_URL: `http://127.0.0.1:${PROXY_PORTS.psp}`,
      PSP_API_KEY,
      PSP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PSP_TIMEOUT_MS: String(options.pspTimeoutMs),
      HOT_ACCOUNT_MODE: 'sharded',
      HOT_ACCOUNT_SHARDS: '16',
      RATE_LIMIT_PER_KEY: '1000000',
      RATE_LIMIT_PER_IP: '1000000',
      IDEMPOTENCY_LEASE_SECONDS: String(options.leaseSeconds),
      RECOVERY_AFTER_SECONDS: '5',
      RECOVERY_EVERY_MS: '1000',
      DATABASE_POOL_SIZE: '10',
    }
    const pspFaults = { seed, slowMs: [500, 3000], ...options.psp }
    services.set(
      'psp',
      new Service(
        'psp',
        PSP_MAIN,
        {
          PSP_DATABASE_URL: pspDb.url,
          PSP_API_KEY,
          PSP_ADMIN_KEY,
          PSP_WEBHOOK_URL: `http://127.0.0.1:${PROXY_PORTS.webhooks}/webhooks/psp`,
          PSP_WEBHOOK_SECRET: WEBHOOK_SECRET,
          PSP_PORT: String(PSP_PORT),
          PSP_HANG_MS: String(options.pspTimeoutMs + 1000),
          PSP_FAULT_PLAN: JSON.stringify(pspFaults),
        },
        logFile('psp'),
        events,
      ),
    )
    services.set(
      'witness',
      new Service('witness', WITNESS_MAIN, { WITNESS_DIR: witnessDir, WITNESS_TOKEN, WITNESS_PORT: String(WITNESS_PORT) }, logFile('witness'), events),
    )
    API_PORTS.forEach((port, i) => {
      services.set(
        `api-${i}`,
        new Service(
          `api-${i}`,
          API_MAIN,
          {
            ...shared,
            PORT: String(port),
            DATABASE_URL: ledgerUrl(i === 0 ? 'api-0-db' : 'api-1-db'),
            CHAOS_FAILPOINTS: failpointSpec(API_FAILPOINTS, options.failpointProbability),
          },
          logFile(`api-${i}`),
          events,
        ),
      )
    })
    services.set(
      'worker',
      new Service(
        'worker',
        WORKER_MAIN,
        {
          ...shared,
          WORKER_PORT: String(WORKER_PORT),
          DATABASE_URL: ledgerUrl('worker-db'),
          KAFKA_BROKERS: `127.0.0.1:${PROXY_PORTS['worker-kafka']}`,
          RELAY_WORKERS: '4',
          WITNESS_URL: `http://127.0.0.1:${PROXY_PORTS.witness}`,
          WITNESS_TOKEN,
          CHECKPOINT_EVERY_MS: '2000',
          CHAOS_FAILPOINTS: failpointSpec(WORKER_FAILPOINTS, options.failpointProbability),
        },
        logFile('worker'),
        events,
      ),
    )
    const service = (name: string) => services.get(name)!
    for (const name of ['psp', 'witness', 'api-0']) {
      service(name).start()
      await until(() => service(name).ready, 60_000, name)
    }
    service('api-1').start()
    service('worker').start()
    await until(() => service('api-1').ready && service('worker').ready, 60_000, 'api-1 and the worker')

    const apis = API_PORTS.map((port, i) => ({ url: `http://127.0.0.1:${port}`, service: service(`api-${i}`) }))
    const endpoints = { live: () => apis.filter((a) => a.service.ready).map((a) => a.url) }
    const clients = new Clients(endpoints, keys, random, log)
    log(`psp faults ${await (await fetch(`http://127.0.0.1:${PSP_PORT}/admin/faults`, { headers: { authorization: `Bearer ${PSP_ADMIN_KEY}` } })).text()}`)
    const merchants = Array.from({ length: options.merchants }, (_, i) => `wash_${i}`)
    for (const code of merchants) {
      const created = await clients.send(clients.record('admin', 'merchant', '/v1/merchants', { code, name: `Wash ${code}`, currency: 'EUR' }))
      if (created?.status !== 200) throw new Error(`could not create merchant ${code}: ${JSON.stringify(created?.body)}`)
    }
    await postgres.checkpoint()
    const journeys = new Journeys(
      clients,
      merchants,
      Object.keys(keys).filter((k) => k !== 'admin'),
    )
    const forger = new Forger(audit, endpoints, WEBHOOK_SECRET, mulberry32(seed ^ 0x77656268))

    let postgresBusy = false
    let kafkaBusy = false
    let toxicCount = 0
    const applyFault = async (fault: PaymentFault, index: number): Promise<void> => {
      try {
        if (fault.kind === 'kill') {
          if (service(fault.target).kill()) {
            report.kills.random[fault.target]!++
            log(`killed ${fault.target}`)
          }
        } else if (fault.kind === 'postgres') {
          if (postgresBusy) return
          postgresBusy = true
          try {
            report.postgres.kills++
            log(`postgres crash, down for ${fault.downMs} ms`)
            report.postgres.recoveryMs.push(await crashPostgres(postgres, fault.downMs))
            log(`postgres back after ${report.postgres.recoveryMs.at(-1)} ms`)
          } finally {
            postgresBusy = false
          }
        } else if (fault.kind === 'kafka') {
          if (kafkaBusy) return
          kafkaBusy = true
          try {
            report.kafka.kills++
            log(`kafka crash, down for ${fault.downMs} ms`)
            report.kafka.recoveryMs.push(await crashKafka(kafka, fault.downMs))
            log(`kafka back after ${report.kafka.recoveryMs.at(-1)} ms`)
          } finally {
            kafkaBusy = false
          }
        } else {
          report.toxics[fault.toxic]!++
          report.toxicsByProxy[fault.proxy]!++
          log(`toxic ${fault.toxic} on ${fault.proxy} for ${fault.lastsMs} ms`)
          await holdToxic(toxiproxy, fault.proxy, fault.toxic, fault.lastsMs, `${fault.toxic}-${toxicCount++}`, mulberry32(seed * 7919 + index))
        }
      } catch (error) {
        report.harnessErrors.push(`${fault.kind} at ${fault.at} ms: ${String(error)}`)
      }
    }

    let checking = false
    const periodicCheck = async () => {
      log(`in flight ${JSON.stringify(Object.fromEntries(clients.inFlight))}; ${await activity(postgres.adminUrl, ledgerDb.name)}`)
      try {
        found.addResults(await checkLedger(audit), 'during')
        found.addResults(await checkPayments(audit), 'during')
        found.addResults([await checkAgainstPsp(audit, psp)], 'during')
        found.addResults([await checkAudit(audit, await readWitness(WITNESS_URL).catch(() => undefined))], 'during')
        report.checks.periodic++
      } catch {
        report.checks.skipped++
      } finally {
        checking = false
      }
    }

    const tasks: Promise<unknown>[] = []
    const track = (task: Promise<unknown>) => tasks.push(task.catch((error: Error) => report.harnessErrors.push(`task: ${error.stack ?? String(error)}`)))
    const faultTasks: Promise<void>[] = []
    const started = performance.now()
    const now = () => performance.now() - started
    let nextJourney = 0
    let nextPayout = 0
    let nextFault = 0
    let nextForgery = 0
    let lastCheck = 0
    let lastSettleCheck = 0
    let settleStarted: number | undefined
    let settling = false
    for (;;) {
      const t = now()
      if (settleStarted === undefined) {
        while (nextJourney < plan.journeys.length && plan.journeys[nextJourney]!.at <= t) track(journeys.payment(plan.journeys[nextJourney++]!))
        while (nextPayout < plan.payouts.length && plan.payouts[nextPayout]!.at <= t) track(journeys.payout(plan.payouts[nextPayout++]!))
        while (nextForgery < plan.forgeries.length && plan.forgeries[nextForgery]! <= t) {
          nextForgery++
          track(forger.forge())
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
          if (!kafka.running) {
            kafka.start()
            await kafka.waitReady()
          }
          for (const s of services.values()) {
            s.disarm()
            s.start()
          }
          await setPspFaults(NO_FAULTS)
          log('faults stopped, settling')
          settleStarted = now()
        }
      }
      if (!checking && postgres.running && !postgresBusy && t - lastCheck >= options.checkEveryMs) {
        lastCheck = t
        checking = true
        void periodicCheck()
      }
      if (settleStarted !== undefined && !settling && t - lastSettleCheck >= 500) {
        lastSettleCheck = t
        settling = true
        const done = await settled(tasks, journeys.probes, audit)
        settling = false
        if (Math.floor((t - settleStarted) / 5000) !== Math.floor((t - settleStarted - 500) / 5000)) {
          log(`settling: ${clients.unanswered()} requests open, ${await pendingAttempts(audit)} attempts pending`)
          log(`in flight ${JSON.stringify(Object.fromEntries(clients.inFlight))}; ${await activity(postgres.adminUrl, ledgerDb.name)}`)
        }
        if (done) break
        if (t - settleStarted > options.settleMs) {
          report.settled = false
          break
        }
      }
      await sleep(5)
    }
    report.settleMs = Math.round(now() - settleStarted!)
    try {
      report.anomalies = await acceptAnomalies(keys.admin!, journeys)
      log(
        `anomalies: ${report.anomalies.open} open, ${report.anomalies.accepted} accepted${report.anomalies.failed.length ? `, refused ${report.anomalies.failed.join('; ')}` : ''}`,
      )
    } catch (error) {
      report.harnessErrors.push(`accepting anomalies: ${String(error)}`)
    }
    const firstDay = Math.floor(Date.parse(report.startedAt) / 1000 / SETTLEMENT_DAY_SECONDS)
    const lastDay = Math.floor(Date.now() / 1000 / SETTLEMENT_DAY_SECONDS)
    for (let day = firstDay; day <= lastDay; day++) {
      try {
        const settled = await settleDay(day, keys.admin!)
        report.settlement.days.push(day)
        report.settlement.outcomes.push(settled.outcome)
        for (const [name, n] of Object.entries(settled.reconciliation?.breaks ?? {})) {
          report.settlement.breaks[name] = (report.settlement.breaks[name] ?? 0) + (n as number)
        }
      } catch (error) {
        report.harnessErrors.push(`settling day ${day}: ${String(error)}`)
      }
    }
    log(`settled days ${report.settlement.days.join(', ')}: ${report.settlement.outcomes.join(', ')}, breaks ${JSON.stringify(report.settlement.breaks)}`)
    const drainedBy = performance.now() + 60_000
    while (performance.now() < drainedBy) {
      const delivered = await Promise.all([checkEvents(audit), checkSequenced(audit)])
        .then(([events, sequenced]) => events.find((r) => r.id === 'L2')!.count === 0 && sequenced.count === 0)
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
    clients.stop()
    await Promise.allSettled([...tasks, ...journeys.probes])
    const witness = await readWitness(WITNESS_URL)
    const history = await fetch(`${WITNESS_URL}/v1/checkpoints`, { signal: AbortSignal.timeout(10_000) })
    if (!history.ok) throw new Error(`the witness answered ${history.status} for its checkpoints`)
    const { data: signed } = (await history.json()) as { data: { size: number }[] }
    report.witness = { checkpoints: signed.length, size: signed.at(-1)?.size ?? 0 }

    stopping = true
    await Promise.all([...services.values()].map((s) => s.stop()))
    while (checking) await sleep(10)

    found.addResults(await checkLedger(audit), 'final')
    found.addResults(await checkPayments(audit), 'final')
    found.addResults([await checkAgainstPsp(audit, psp), await checkSettled(audit)], 'final')
    found.addResults(await checkEvents(audit), 'final')
    found.addResults([await checkAudit(audit, witness), await checkSequenced(audit, witness)], 'final')
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

    Object.assign(report, {
      outcomes: journeys.outcomes,
      payoutOutcomes: journeys.payoutOutcomes,
      requests: clients.stats.requests,
      sends: clients.stats.sends,
      duplicates: clients.stats.duplicates,
      probes: clients.probes.length,
      answers: clients.stats.answers,
      surprises: journeys.surprises,
      forged: forger.outcomes,
      starts: Object.fromEntries([...services].map(([name, s]) => [name, s.starts])),
      ledger: {
        anomalies: await countBy(audit, 'SELECT kind AS name, count(*)::int AS n FROM anomalies GROUP BY kind'),
        webhooks: await countBy(audit, 'SELECT outcome AS name, count(*)::int AS n FROM webhook_events GROUP BY outcome'),
      },
      pspOperations: await countBy(psp, `SELECT kind || ' ' || status AS name, count(*)::int AS n FROM operations GROUP BY 1`),
      events: {
        ...(await countBy(audit, `SELECT 'outbox ' || topic AS name, count(*)::int AS n FROM outbox GROUP BY topic`)),
        ...(await countBy(audit, `SELECT 'inbox ' || consumer AS name, count(*)::int AS n FROM inbox GROUP BY consumer`)),
        receipts: (await audit.query<{ n: number }>('SELECT count(*)::int AS n FROM receipts')).rows[0]!.n,
        ...(await publishedMessages(kafka.directBroker)),
      },
    })
    return report
  } finally {
    stopping = true
    await Promise.all([...services.values()].map((s) => s.stop())).catch(() => undefined)
    await kafka.stop().catch(() => undefined)
    await psp.end().catch(() => undefined)
    await keepLogs(logs, join(lab.dir, 'logs'), seed).catch((error) => log(`could not keep the service logs: ${String(error)}`))
    await pspDb.drop().catch((error) => log(`psp drop failed: ${String(error)}`))
    await ledgerDb.drop().catch((error) => log(`drop failed: ${String(error)}`))
  }

  async function acceptAnomalies(adminKey: string, journeys: Journeys): Promise<PaymentsReport['anomalies']> {
    const base = `http://127.0.0.1:${API_PORTS[0]}/v1/admin/anomalies`
    const headers = { authorization: `Bearer ${adminKey}` }
    const listed = await fetch(`${base}?state=open&limit=200`, { headers })
    if (listed.status !== 200) throw new Error(`listing anomalies: status ${listed.status}`)
    const open = (await listed.json()).data as { id: string; acceptable: boolean }[]
    const result: PaymentsReport['anomalies'] = { open: open.length, accepted: 0, failed: [] }
    for (const anomaly of open.filter((a) => a.acceptable)) {
      const response = await fetch(`${base}/${anomaly.id}/accept`, { method: 'POST', headers })
      const body = await response.json().catch(() => null)
      if (response.status !== 200) {
        result.failed.push(`${anomaly.id}: ${response.status} ${body?.error?.message ?? ''}`)
        continue
      }
      result.accepted++
      journeys.learnAccepted(body)
    }
    return result
  }

  async function settleDay(day: number, adminKey: string): Promise<{ outcome: string; reconciliation?: { breaks: Record<string, number> } }> {
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
          headers: { authorization: `Bearer ${adminKey}`, 'idempotency-key': `settle-${day}-${attempt}` },
          signal: AbortSignal.timeout(30_000),
        })
        if (response.status !== 201) throw new Error(`ingesting day ${day}: status ${response.status} ${await response.text()}`)
        return (await response.json()) as { outcome: string; reconciliation?: { breaks: Record<string, number> } }
      } catch (error) {
        if (attempt >= 20) throw error
        await sleep(500)
      }
    }
  }

  async function setPspFaults(plan: unknown): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${PSP_PORT}/admin/faults`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${PSP_ADMIN_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify(plan),
          signal: AbortSignal.timeout(5000),
        })
        if (response.ok) return
        throw new Error(`status ${response.status}`)
      } catch (error) {
        if (attempt >= 50) throw error
        await sleep(200)
      }
    }
  }
}

async function activity(adminUrl: string, database: string): Promise<string> {
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 2000 })
  client.on('error', () => undefined)
  try {
    await client.connect()
    const { rows } = await client.query<{ state: string; wait: string; n: number; oldest: number }>(
      `SELECT coalesce(state, '-') AS state, coalesce(wait_event_type || ':' || wait_event, '-') AS wait, count(*)::int AS n,
              coalesce(max(extract(epoch FROM now() - xact_start)), 0)::int AS oldest
       FROM pg_stat_activity WHERE datname = $1 GROUP BY 1, 2 ORDER BY 3 DESC`,
      [database],
    )
    const stuck = await client.query<{ pid: number; state: string; age: number; blockers: number[]; query: string }>(
      `SELECT pid, state, extract(epoch FROM now() - xact_start)::int AS age, pg_blocking_pids(pid) AS blockers, left(query, 160) AS query
       FROM pg_stat_activity
       WHERE datname = $1 AND xact_start < now() - interval '3 seconds'
       ORDER BY xact_start LIMIT 4`,
      [database],
    )
    const summary = rows.map((r) => `${r.state} ${r.wait} ${r.n} (oldest ${r.oldest} s)`).join(', ')
    const detail = stuck.rows.map((r) => `[${r.pid} ${r.state} ${r.age} s blocked by ${JSON.stringify(r.blockers)}: ${r.query.replace(/\s+/g, ' ')}]`)
    return [summary, ...detail].join(' ')
  } catch {
    return 'activity unavailable'
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function keepLogs(from: string, to: string, seed: number): Promise<void> {
  mkdirSync(to, { recursive: true })
  for (const name of ['psp', 'witness', 'api-0', 'api-1', 'worker', 'kafka']) {
    await pipeline(createReadStream(join(from, `${name}.log`)), createGzip(), createWriteStream(join(to, `seed-${seed}-${name}.log.gz`)))
  }
  rmSync(from, { recursive: true, force: true })
}

async function pendingAttempts(audit: pg.Pool): Promise<string> {
  try {
    const { rows } = await audit.query<{ n: number }>(`SELECT count(*)::int AS n FROM attempts WHERE status = 'pending'`)
    return String(rows[0]!.n)
  } catch {
    return 'unknown'
  }
}

async function settled(tasks: readonly Promise<unknown>[], probes: readonly Promise<unknown>[], audit: pg.Pool): Promise<boolean> {
  const pending = Symbol('pending')
  const race = await Promise.race([Promise.allSettled([...tasks, ...probes]).then(() => 'done'), sleep(0, pending)])
  if (race === pending) return false
  try {
    if ((await checkSettled(audit)).count > 0) return false
    if ((await checkSequenced(audit)).count > 0) return false
    return (await checkEvents(audit)).find((result) => result.id === 'L2')!.count === 0
  } catch {
    return false
  }
}

async function publishedMessages(broker: string): Promise<Record<string, number>> {
  const admin = kafkaClient({ brokers: [broker], clientId: 'chaos-harness' }).admin()
  try {
    await admin.connect()
    const counts: Record<string, number> = {}
    for (const topic of ['payments', 'ledger']) {
      const offsets = await admin.fetchTopicOffsets(topic)
      counts[`kafka ${topic}`] = offsets.reduce((sum, p) => sum + Number(p.high) - Number(p.low), 0)
    }
    return counts
  } catch {
    return {}
  } finally {
    await admin.disconnect().catch(() => undefined)
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
    witnessCheckpoints: sum((r) => r.witness.checkpoints),
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
    `witnessed ${r.witness.size} leaves in ${r.witness.checkpoints} checkpoints, ` +
    `settled ${r.settled ? `in ${(r.settleMs / 1000).toFixed(1)} s` : 'NOT'}, ${found}`
  )
}
