import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { NO_FAULTS, startPsp, type RunningPsp } from '@carwash/psp'
import { createScratchDatabase, createTestDatabase, type ScratchDatabase, type TestDatabase } from '@carwash/testkit'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import pg from 'pg'
import { AppModule, configureApp } from '../src/app.module.ts'
import { hashApiKey } from '../src/auth/api-keys.ts'
import type { ApiConfig } from '../src/config.ts'

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
    },
    () => undefined,
  )
  const config = apiConfig(ledgerDb.url('ledger_app'), psp.url, { webhookSecret: options.webhooks ? WEBHOOK_SECRET : undefined })
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
