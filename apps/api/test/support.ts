import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Env } from '@carwash/env'
import { applyOnce, type ConsumedEvent } from '@carwash/outbox'
import { firstRow } from '@carwash/pg'
import { NO_FAULTS, startPsp, type RunningPsp } from '@carwash/psp'
import { createScratchDatabase, createTestDatabase, type ScratchDatabase, type TestDatabase } from '@carwash/testkit'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import pg from 'pg'
import { AppModule, configureApp } from '../src/app.module.ts'
import { hashApiKey } from '../src/auth/api-keys.ts'
import { loadApiConfig, loadCoreConfig, loadWorkerConfig, type ApiConfig, type CoreConfig, type WorkerConfig } from '../src/config.ts'
import { CONSUMERS } from '../src/consumers/event-consumers.service.ts'

export const KEYS = { alice: 'cw_live_alice', bob: 'cw_live_bob', admin: 'cw_admin_ops' }
export const WEBHOOK_SECRET = 'whsec_test'

export type Caller = keyof typeof KEYS | 'nobody'

export interface Reply {
  status: number
  body: unknown
  replayed: boolean
  retryAfter: string | null
}

export interface CallOptions {
  key?: string | null
  body?: unknown
  as?: Caller
  base?: string
  bearer?: string
}

export interface Stack {
  ledgerDb: TestDatabase
  pspDb: ScratchDatabase
  psp: RunningPsp
  app: NestExpressApplication
  url: string
  env: Env
  config: TestConfig
  owner: pg.Pool
  admin: pg.Pool
  pspSql: pg.Pool
  clientIds: Record<keyof typeof KEYS, string>
  call: (method: string, path: string, options?: CallOptions) => Promise<Reply>
  close(): Promise<void>
}

export interface TestConfig {
  core: CoreConfig
  api: ApiConfig
  worker: WorkerConfig
}

export function testConfig(env: Env): TestConfig {
  const all: Env = {
    PORT: '0',
    WORKER_PORT: '0',
    PSP_API_KEY: 'sk_test_api',
    PSP_TIMEOUT_MS: '500',
    HOT_ACCOUNT_SHARDS: '4',
    RATE_LIMIT_PER_KEY: '10000',
    RATE_LIMIT_PER_IP: '10000',
    RECOVERY_EVERY_MS: '0',
    SETTLEMENT_EVERY_MS: '0',
    AUDIT_EVERY_MS: '0',
    WITNESS_TIMEOUT_MS: '2000',
    LIVE_EVERY_MS: '200',
    CHECKS_EVERY_MS: '0',
    VERIFY_EVERY_MS: '0',
    ...env,
  }
  return { core: loadCoreConfig(all), api: loadApiConfig(all), worker: loadWorkerConfig(all) }
}

export async function startApi(config: { core: CoreConfig; api: ApiConfig }, port = 0): Promise<{ app: NestExpressApplication; url: string }> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    bodyParser: false,
    rawBody: true,
    logger: false,
  })
  configureApp(app, config.api)
  await app.listen(port, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

export async function call(base: string, method: string, path: string, options: CallOptions = {}): Promise<Reply> {
  const as = options.as ?? 'alice'
  const response = await fetch(`${options.base ?? base}${path}`, {
    method,
    headers: {
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : as === 'nobody' ? {} : { authorization: `Bearer ${KEYS[as]}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'POST' && options.key !== null ? { 'idempotency-key': options.key ?? randomUUID() } : {}),
    },
    body: options.body === undefined ? null : JSON.stringify(options.body),
  })
  return {
    status: response.status,
    body: await response.json(),
    replayed: response.headers.get('idempotent-replayed') === 'true',
    retryAfter: response.headers.get('retry-after'),
  }
}

export async function count(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  return firstRow(await pool.query<{ n: number }>(sql, params)).n
}

async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

export async function startStack(options: { webhooks?: boolean } = {}): Promise<Stack> {
  const ledgerDb = await createTestDatabase()
  const pspDb = await createScratchDatabase('psp')
  const owner = ledgerDb.pool('ledger_owner', 2)
  const admin = ledgerDb.pool('admin', 2)
  const pspSql = new pg.Pool({ connectionString: pspDb.url, max: 2 })
  const clientIds = {} as Record<keyof typeof KEYS, string>
  for (const [name, key] of Object.entries(KEYS) as [keyof typeof KEYS, string][]) {
    const { id } = firstRow(
      await owner.query<{ id: string }>('INSERT INTO api_clients (name, key_hash, scope) VALUES ($1, $2, $3::client_scope) RETURNING id::text', [
        name,
        hashApiKey(key),
        name === 'admin' ? 'admin' : 'client',
      ]),
    )
    clientIds[name] = id
  }
  const apiPort = await freePort()
  const psp = await startPsp(
    {
      port: 0,
      databaseUrl: pspDb.url,
      apiKey: 'sk_test_api',
      adminKey: 'sk_test_admin',
      webhook: options.webhooks ? { url: `http://127.0.0.1:${apiPort}/webhooks/psp`, secret: WEBHOOK_SECRET } : undefined,
      authorizationTtlSeconds: 3600,
      idempotencyWindowSeconds: 24 * 3600,
      hangMs: 1500,
      faultPlan: NO_FAULTS,
      settlementDaySeconds: 86_400,
      feeBps: 120,
      feeFixed: 8,
    },
    () => undefined,
  )
  const env = {
    DATABASE_URL: ledgerDb.url('ledger_app'),
    PSP_URL: psp.url,
    PSP_WEBHOOK_SECRET: options.webhooks ? WEBHOOK_SECRET : undefined,
    AUDIT_DATABASE_URL: ledgerDb.url('ledger_audit'),
  }
  const config = testConfig(env)
  const { app, url } = await startApi(config, apiPort)
  const stack: Stack = {
    ledgerDb,
    pspDb,
    psp,
    app,
    url,
    env,
    config,
    owner,
    admin,
    pspSql,
    clientIds,
    call: (method, path, callOptions) => call(url, method, path, callOptions),
    close: async () => {
      await app.close()
      await psp.close()
      await pspSql.end()
      await pspDb.drop()
      await ledgerDb.drop()
    },
  }
  for (const code of ['wash_1', 'wash_2']) {
    const created = await stack.call('POST', '/v1/merchants', { as: 'admin', body: { code, name: `Wash ${code}`, currency: 'EUR' } })
    if (created.status !== 200) throw new Error(`could not create merchant ${code}: ${JSON.stringify(created.body)}`)
  }
  return stack
}

export interface OutboxEvent extends ConsumedEvent {
  topic: string
}

export async function outboxEvents(pool: pg.Pool, which: 'unpublished' | 'all' = 'unpublished'): Promise<OutboxEvent[]> {
  const { rows } = await pool.query<{ id: string; topic: string; key: string; type: string; data: unknown; created_at: Date }>(
    `SELECT o.event_id::text AS id, o.topic, o.key, o.type, o.payload AS data, o.created_at
     FROM outbox o ${which === 'unpublished' ? 'WHERE o.published_at IS NULL' : ''}
     ORDER BY o.id`,
  )
  return rows.map((row) => ({ id: row.id, topic: row.topic, key: row.key, type: row.type, data: row.data, occurredAt: row.created_at.toISOString() }))
}

export async function deliver(pool: pg.Pool, batches: readonly (readonly OutboxEvent[])[]): Promise<void> {
  for (const batch of batches) {
    for (const spec of CONSUMERS)
      await applyOnce(
        pool,
        spec,
        batch.filter((event) => event.topic === spec.topic),
      )
  }
  const ids = [...new Set(batches.flat().map((event) => event.id))]
  await pool.query('UPDATE outbox SET published_at = now() WHERE event_id = ANY($1::uuid[]) AND published_at IS NULL', [ids])
}
