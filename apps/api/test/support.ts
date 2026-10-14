import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { applyOnce, type ConsumedEvent } from '@carwash/outbox'
import { NO_FAULTS, startPsp, type RunningPsp } from '@carwash/psp'
import { createScratchDatabase, createTestDatabase, type ScratchDatabase, type TestDatabase } from '@carwash/testkit'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import pg from 'pg'
import { AppModule, configureApp } from '../src/app.module.ts'
import { hashApiKey } from '../src/auth/api-keys.ts'
import type { ApiConfig } from '../src/config.ts'
import { CONSUMERS } from '../src/consumers/event-consumers.service.ts'

export const KEYS = { alice: 'cw_live_alice', bob: 'cw_live_bob', admin: 'cw_admin_ops' }
export const WEBHOOK_SECRET = 'whsec_test'

export type Caller = keyof typeof KEYS | 'nobody'

export interface Reply {
  status: number
  body: any
  replayed: boolean
  retryAfter: string | null
}

export interface CallOptions {
  key?: string | null
  body?: unknown
  as?: Caller
  base?: string
}

export interface Stack {
  ledgerDb: TestDatabase
  pspDb: ScratchDatabase
  psp: RunningPsp
  app: NestExpressApplication
  url: string
  config: ApiConfig
  owner: pg.Pool
  admin: pg.Pool
  pspSql: pg.Pool
  clientIds: Record<keyof typeof KEYS, string>
  call(method: string, path: string, options?: CallOptions): Promise<Reply>
  close(): Promise<void>
}

export function apiConfig(databaseUrl: string, pspUrl: string, overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    port: 0,
    databaseUrl,
    poolSize: 10,
    connectTimeoutMs: 5000,
    transactionTimeoutMs: 10_000,
    pspUrl,
    pspApiKey: 'sk_test_api',
    pspTimeoutMs: 500,
    currencies: ['EUR'],
    hotAccountMode: 'sharded',
    hotAccountShards: 4,
    feeBps: 200,
    feeFixed: 10n,
    leaseSeconds: 30,
    idempotencyWindowSeconds: 24 * 3600,
    rateLimitPerKey: 10_000,
    rateLimitPerIp: 10_000,
    trustProxy: 'loopback',
    webhookSecret: undefined,
    workerPort: 0,
    recoveryAfterSeconds: 30,
    recoveryEveryMs: 0,
    webhookRetentionDays: 7,
    kafkaBrokers: [],
    relayWorkers: 4,
    outboxRetentionHours: 24,
    kafkaTopicPrefix: '',
    inboxRetentionDays: 7,
    pspFeeBps: 120,
    pspFeeFixed: 8n,
    reconFallback: 'unique',
    reconWindowDays: 7,
    settlementEveryMs: 0,
    auditEveryMs: 0,
    auditBatch: 1000,
    witnessUrl: undefined,
    witnessToken: undefined,
    witnessTimeoutMs: 2000,
    checkpointEveryMs: 10_000,
    checkpointEveryLeaves: 10_000,
    auditDatabaseUrl: undefined,
    liveEveryMs: 200,
    liveMaxConnections: 100,
    plugEveryMs: 60_000,
    checksEveryMs: 0,
    ...overrides,
  }
}

export async function startApi(config: ApiConfig, port = 0): Promise<{ app: NestExpressApplication; url: string }> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    bodyParser: false,
    rawBody: true,
    logger: false,
  })
  configureApp(app, config)
  await app.listen(port, '127.0.0.1')
  return { app, url: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}` }
}

export async function call(base: string, method: string, path: string, options: CallOptions = {}): Promise<Reply> {
  const as = options.as ?? 'alice'
  const response = await fetch(`${options.base ?? base}${path}`, {
    method,
    headers: {
      ...(as === 'nobody' ? {} : { authorization: `Bearer ${KEYS[as]}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'POST' && options.key !== null ? { 'idempotency-key': options.key ?? randomUUID() } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return {
    status: response.status,
    body: await response.json(),
    replayed: response.headers.get('idempotent-replayed') === 'true',
    retryAfter: response.headers.get('retry-after'),
  }
}

export async function count(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params)
  return rows[0]!.n
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
    const { rows } = await owner.query<{ id: string }>(
      'INSERT INTO api_clients (name, key_hash, scope) VALUES ($1, $2, $3::client_scope) RETURNING id::text',
      [name, hashApiKey(key), name === 'admin' ? 'admin' : 'client'],
    )
    clientIds[name] = rows[0]!.id
  }
  const apiPort = await freePort()
  const psp = await startPsp(
    {
      port: 0,
      databaseUrl: pspDb.url,
      apiKey: 'sk_test_api',
      adminKey: 'sk_test_admin',
      webhookUrl: options.webhooks ? `http://127.0.0.1:${apiPort}/webhooks/psp` : undefined,
      webhookSecret: options.webhooks ? WEBHOOK_SECRET : undefined,
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
  const config = apiConfig(ledgerDb.url('ledger_app'), psp.url, { webhookSecret: options.webhooks ? WEBHOOK_SECRET : undefined, auditDatabaseUrl: ledgerDb.url('ledger_audit') })
  const { app, url } = await startApi(config, apiPort)
  const stack: Stack = {
    ledgerDb,
    pspDb,
    psp,
    app,
    url,
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
    for (const spec of CONSUMERS) await applyOnce(pool, spec, batch.filter((event) => event.topic === spec.topic))
  }
  const ids = [...new Set(batches.flat().map((event) => event.id))]
  await pool.query('UPDATE outbox SET published_at = now() WHERE event_id = ANY($1::uuid[]) AND published_at IS NULL', [ids])
}
