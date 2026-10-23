import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'
import { failpointSpec, type FailpointName } from '@carwash/failpoints'
import { createPool } from '@carwash/pg'
import { createScratchDatabase, createTestDatabase, type ScratchDatabase, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { withPort, type Lab } from '../lab.ts'
import { Service, type ServiceEvents } from '../service.ts'
import type { Endpoints } from './client.ts'
import { PROXIES, type ProxyName } from './plan.ts'
import type { PaymentsOptions } from './options.ts'

const ROOT = new URL('../../../../', import.meta.url)
const API_MAIN = fileURLToPath(new URL('apps/api/dist/main.js', ROOT))
const WORKER_MAIN = fileURLToPath(new URL('apps/api/dist/worker.js', ROOT))
const PSP_MAIN = fileURLToPath(new URL('apps/psp/src/main.ts', ROOT))
const WITNESS_MAIN = fileURLToPath(new URL('apps/witness/src/main.ts', ROOT))

const POSTGRES_PORT = 5432
export const PSP_PORT = 3142
export const API_PORTS = [3140, 3141] as const
const WORKER_PORT = 3144
const WITNESS_PORT = 3145
export const WITNESS_URL = `http://127.0.0.1:${WITNESS_PORT}`
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
  webhooks: API_PORTS[0],
  'worker-kafka': KAFKA_PROXY_UPSTREAM,
  witness: WITNESS_PORT,
}

export const SETTLEMENT_DAY_SECONDS = 86_400
const PSP_API_KEY = 'sk_chaos_api'
export const PSP_ADMIN_KEY = 'sk_chaos_admin'
export const ADMIN_KEY = 'cw_chaos_admin'
export const WEBHOOK_SECRET = 'whsec_chaos'
const WITNESS_TOKEN = 'witness_chaos'

const API_FAILPOINTS = ['post.', 'transaction.', 'attempt.', 'request.', 'webhook.']
const WORKER_FAILPOINTS = ['post.', 'transaction.', 'attempt.', 'recovery.', 'webhook.', 'relay.', 'consumer.', 'checkpoint.']

function failpointRate(probability: number): (name: FailpointName) => number {
  return (name) => {
    if (name.startsWith('transaction.')) return probability
    if (name.startsWith('checkpoint.')) return Math.min(1, probability * 200)
    return Math.min(1, probability * 4)
  }
}

async function keepLogs(from: string, to: string, seed: number): Promise<void> {
  mkdirSync(to, { recursive: true })
  for (const name of ['psp', 'witness', 'api-0', 'api-1', 'worker', 'kafka']) {
    await pipeline(createReadStream(join(from, `${name}.log`)), createGzip(), createWriteStream(join(to, `seed-${seed}-${name}.log.gz`)))
  }
  rmSync(from, { recursive: true, force: true })
}

async function until(ready: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const started = performance.now()
  while (!ready()) {
    if (performance.now() - started > timeoutMs) throw new Error(`${what} did not get ready in ${timeoutMs} ms`)
    await sleep(50)
  }
}

export class PaymentsStack {
  readonly ledgerDb: TestDatabase
  readonly pspDb: ScratchDatabase
  readonly psp: pg.Pool
  readonly owner: pg.Pool
  readonly audit: pg.Pool
  readonly keys: Readonly<Record<string, string>>
  readonly #lab: Lab
  readonly #options: PaymentsOptions
  readonly #seed: number
  readonly #log: (line: string) => void
  readonly #services = new Map<string, Service>()
  readonly #logs: string
  readonly #witnessDir: string

  private constructor(lab: Lab, options: PaymentsOptions, seed: number, log: (line: string) => void, ledgerDb: TestDatabase, pspDb: ScratchDatabase) {
    this.#lab = lab
    this.#options = options
    this.#seed = seed
    this.#log = log
    this.ledgerDb = ledgerDb
    this.pspDb = pspDb
    this.psp = createPool({ connectionString: pspDb.url, max: 2 })
    this.owner = ledgerDb.pool('ledger_owner', 1)
    this.audit = ledgerDb.pool('ledger_audit', 3)
    const keys: Record<string, string> = { admin: ADMIN_KEY }
    for (let i = 0; i < options.clients; i++) keys[`client-${i}`] = `cw_chaos_client_${i}`
    this.keys = keys
    this.#logs = `/tmp/chaos-logs/seed-${seed}`
    mkdirSync(this.#logs, { recursive: true })
    this.#witnessDir = `/tmp/chaos-witness/seed-${seed}`
    rmSync(this.#witnessDir, { recursive: true, force: true })
  }

  static async create(lab: Lab, options: PaymentsOptions, seed: number, log: (line: string) => void): Promise<PaymentsStack> {
    const ledgerDb = await createTestDatabase()
    let pspDb: ScratchDatabase | undefined
    try {
      pspDb = await createScratchDatabase('psp')
      return new PaymentsStack(lab, options, seed, log, ledgerDb, pspDb)
    } catch (error) {
      await pspDb?.drop()
      await ledgerDb.drop()
      throw error
    }
  }

  get services(): Service[] {
    return [...this.#services.values()]
  }

  service(name: string): Service {
    const found = this.#services.get(name)
    if (found === undefined) throw new Error(`there is no service ${name}`)
    return found
  }

  endpoints(): Endpoints {
    const apis = API_PORTS.map((port, i) => ({ url: `http://127.0.0.1:${port}`, service: this.service(`api-${i}`) }))
    return { live: () => apis.filter((a) => a.service.ready).map((a) => a.url) }
  }

  async start(events: ServiceEvents): Promise<void> {
    const lab = this.#lab
    const options = this.#options
    for (const [name, key] of Object.entries(this.keys)) {
      await this.owner.query('INSERT INTO api_clients (name, key_hash, scope) VALUES ($1, $2, $3::client_scope)', [
        name,
        createHash('sha256').update(key).digest(),
        name === 'admin' ? 'admin' : 'client',
      ])
    }

    lab.kafka.fresh(this.#logFile('kafka'))
    lab.kafka.start()
    await lab.kafka.waitReady()

    await lab.toxiproxy.reset()
    for (const proxy of PROXIES) await lab.toxiproxy.replaceProxy(proxy, PROXY_PORTS[proxy], PROXY_UPSTREAMS[proxy])

    const ledgerUrl = (proxy: ProxyName) => withPort(this.ledgerDb.url('ledger_app'), PROXY_PORTS[proxy])
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
    const faultPlan = { seed: this.#seed, slowMs: [500, 3000], ...options.psp }
    this.#add(
      'psp',
      PSP_MAIN,
      {
        PSP_DATABASE_URL: this.pspDb.url,
        PSP_API_KEY,
        PSP_ADMIN_KEY,
        PSP_WEBHOOK_URL: `http://127.0.0.1:${PROXY_PORTS.webhooks}/webhooks/psp`,
        PSP_WEBHOOK_SECRET: WEBHOOK_SECRET,
        PSP_PORT: String(PSP_PORT),
        PSP_HANG_MS: String(options.pspTimeoutMs + 1000),
        PSP_FAULT_PLAN: JSON.stringify(faultPlan),
      },
      events,
    )
    this.#add('witness', WITNESS_MAIN, { WITNESS_DIR: this.#witnessDir, WITNESS_TOKEN, WITNESS_PORT: String(WITNESS_PORT) }, events)
    API_PORTS.forEach((port, i) => {
      this.#add(
        `api-${i}`,
        API_MAIN,
        {
          ...shared,
          PORT: String(port),
          DATABASE_URL: ledgerUrl(i === 0 ? 'api-0-db' : 'api-1-db'),
          CHAOS_FAILPOINTS: failpointSpec(API_FAILPOINTS, failpointRate(options.failpointProbability)),
        },
        events,
      )
    })
    this.#add(
      'worker',
      WORKER_MAIN,
      {
        ...shared,
        WORKER_PORT: String(WORKER_PORT),
        DATABASE_URL: ledgerUrl('worker-db'),
        AUDIT_DATABASE_URL: withPort(this.ledgerDb.url('ledger_audit'), PROXY_PORTS['worker-db']),
        KAFKA_BROKERS: `127.0.0.1:${PROXY_PORTS['worker-kafka']}`,
        RELAY_WORKERS: '4',
        WITNESS_URL: `http://127.0.0.1:${PROXY_PORTS.witness}`,
        WITNESS_TOKEN,
        CHECKPOINT_EVERY_MS: '2000',
        CHAOS_FAILPOINTS: failpointSpec(WORKER_FAILPOINTS, failpointRate(options.failpointProbability)),
      },
      events,
    )
    for (const name of ['psp', 'witness', 'api-0']) {
      this.service(name).start()
      await until(() => this.service(name).ready, 60_000, name)
    }
    this.service('api-1').start()
    this.service('worker').start()
    await until(() => this.service('api-1').ready && this.service('worker').ready, 60_000, 'api-1 and the worker')
  }

  async stopServices(): Promise<void> {
    await Promise.all(this.services.map((s) => s.stop()))
  }

  async close(): Promise<void> {
    const log = this.#log
    await this.stopServices().catch(() => undefined)
    await this.#lab.kafka.stop().catch(() => undefined)
    await this.psp.end().catch(() => undefined)
    await keepLogs(this.#logs, join(this.#lab.dir, 'logs'), this.#seed).catch((error: unknown) => log(`could not keep the service logs: ${String(error)}`))
    await this.pspDb.drop().catch((error: unknown) => log(`psp drop failed: ${String(error)}`))
    await this.ledgerDb.drop().catch((error: unknown) => log(`drop failed: ${String(error)}`))
  }

  #logFile(name: string): string {
    return join(this.#logs, `${name}.log`)
  }

  #add(name: string, entry: string, env: NodeJS.ProcessEnv, events: ServiceEvents): void {
    this.#services.set(name, new Service(name, entry, env, this.#logFile(name), events))
  }
}
