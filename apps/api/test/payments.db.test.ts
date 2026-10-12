import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { checkLedger, violations } from '@carwash/invariants'
import { NO_FAULTS, startPsp, type RunningPsp } from '@carwash/psp'
import { createScratchDatabase, createTestDatabase, type ScratchDatabase, type TestDatabase } from '@carwash/testkit'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule, configureApp } from '../src/app.module.ts'
import { hashApiKey } from '../src/auth/api-keys.ts'
import type { ApiConfig } from '../src/config.ts'
import { Database } from '../src/db/database.ts'
import { requestHash } from '../src/idempotency/request-hash.ts'

const KEYS = { alice: 'cw_live_alice', bob: 'cw_live_bob', admin: 'cw_admin_ops' }

interface Reply {
  status: number
  body: any
  replayed: boolean
  retryAfter: string | null
}

let ledgerDb: TestDatabase
let pspDb: ScratchDatabase
let psp: RunningPsp
let app: NestExpressApplication
let url: string
let owner: pg.Pool
let admin: pg.Pool
let pspSql: pg.Pool
let clientIds: Record<keyof typeof KEYS, string>

function config(pspUrl: string): ApiConfig {
  return {
    port: 0,
    databaseUrl: ledgerDb.url('ledger_app'),
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
  }
}

async function startApi(apiConfig: ApiConfig): Promise<{ app: NestExpressApplication; url: string }> {
  const instance = await NestFactory.create<NestExpressApplication>(AppModule.register(apiConfig), { bodyParser: false, logger: false })
  configureApp(instance, apiConfig)
  await instance.listen(0, '127.0.0.1')
  return { app: instance, url: `http://127.0.0.1:${(instance.getHttpServer().address() as AddressInfo).port}` }
}

async function call(
  method: string,
  path: string,
  options: { key?: string | null; body?: unknown; as?: keyof typeof KEYS | 'nobody'; base?: string } = {},
): Promise<Reply> {
  const as = options.as ?? 'alice'
  const response = await fetch(`${options.base ?? url}${path}`, {
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

function pay(token: string, extra: Record<string, unknown> = {}) {
  return { amount: 1500, currency: 'EUR', merchant: 'wash_1', token, ...extra }
}

async function balance(code: string): Promise<number> {
  const reply = await call('GET', `/v1/accounts/${encodeURIComponent(code)}/balance`)
  return reply.body.balance
}

async function count(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params)
  return rows[0]!.n
}

beforeAll(async () => {
  ledgerDb = await createTestDatabase()
  pspDb = await createScratchDatabase('psp')
  owner = ledgerDb.pool('ledger_owner', 2)
  admin = ledgerDb.pool('admin', 2)
  pspSql = new pg.Pool({ connectionString: pspDb.url, max: 2 })
  clientIds = {} as typeof clientIds
  for (const [name, key] of Object.entries(KEYS) as [keyof typeof KEYS, string][]) {
    const { rows } = await owner.query<{ id: string }>(
      'INSERT INTO api_clients (name, key_hash, scope) VALUES ($1, $2, $3::client_scope) RETURNING id::text',
      [name, hashApiKey(key), name === 'admin' ? 'admin' : 'client'],
    )
    clientIds[name] = rows[0]!.id
  }
  psp = await startPsp(
    {
      port: 0,
      databaseUrl: pspDb.url,
      apiKey: 'sk_test_api',
      adminKey: 'sk_test_admin',
      webhookUrl: undefined,
      webhookSecret: undefined,
      authorizationTtlSeconds: 3600,
      idempotencyWindowSeconds: 24 * 3600,
      hangMs: 1500,
      faultPlan: NO_FAULTS,
    },
    () => undefined,
  )
  const started = await startApi(config(psp.url))
  app = started.app
  url = started.url
  for (const code of ['wash_1', 'wash_2']) {
    const created = await call('POST', '/v1/merchants', { as: 'admin', body: { code, name: `Wash ${code}`, currency: 'EUR' } })
    expect(created.status).toBe(200)
  }
})

afterAll(async () => {
  await app?.close()
  await psp?.close()
  await pspSql?.end()
  await pspDb?.drop()
  await ledgerDb?.drop()
})

describe('payments API', () => {
  it('authorizes and captures a payment, and posts one balanced capture journal', async () => {
    const reply = await call('POST', '/v1/payments', { body: pay('tok_ok') })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ object: 'payment', status: 'captured', amount: 1500, captured_amount: 1500, fee: 40 })
    const { rows } = await admin.query<{ account: string; amount: string }>(
      `SELECT a.code AS account, e.amount::text FROM journals j JOIN entries e ON e.journal_id = j.id JOIN accounts a ON a.id = e.account_id
       WHERE j.external_ref = $1 ORDER BY a.code`,
      [`capture:${reply.body.id}`],
    )
    expect(rows).toEqual([
      { account: 'merchant_payable:wash_1', amount: '-1460' },
      { account: 'platform_fee_revenue:EUR', amount: '-40' },
      { account: 'psp_receivable:EUR', amount: '1500' },
    ])
    expect((await call('GET', `/v1/payments/${reply.body.id}`)).body).toEqual(reply.body)
  })

  it('replays the stored answer for the same key and refuses the same key with a different body', async () => {
    const key = randomUUID()
    const first = await call('POST', '/v1/payments', { key, body: pay('tok_ok') })
    const second = await call('POST', '/v1/payments', { key, body: { token: 'tok_ok', merchant: 'wash_1', currency: 'EUR', amount: 1500 } })
    expect(second).toMatchObject({ status: 200, replayed: true, body: first.body })
    const reused = await call('POST', '/v1/payments', { key, body: pay('tok_ok', { amount: 1501 }) })
    expect(reused.status).toBe(422)
    expect(reused.body.error.code).toBe('idempotency_key_reused')
  })

  it('makes one payment out of 20 concurrent requests with one key', async () => {
    const key = randomUUID()
    const body = pay('tok_ok', { amount: 2000 })
    const replies = await Promise.all(Array.from({ length: 20 }, () => call('POST', '/v1/payments', { key, body })))
    expect(replies.every((r) => r.status === 200 || (r.status === 409 && r.retryAfter === '1'))).toBe(true)
    const done = replies.filter((r) => r.status === 200)
    expect(done.length).toBeGreaterThanOrEqual(1)
    expect(new Set(done.map((r) => r.body.id)).size).toBe(1)
    const settled = await call('POST', '/v1/payments', { key, body })
    expect(settled).toMatchObject({ status: 200, replayed: true, body: { id: done[0]!.body.id } })
    expect(await count(admin, `SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`, [key])).toBe(1)
    expect(await count(admin, `SELECT count(*)::int AS n FROM journals WHERE external_ref = $1`, [`capture:${done[0]!.body.id}`])).toBe(1)
  })

  it('stores a decline as a 402 and replays it', async () => {
    const key = randomUUID()
    const declined = await call('POST', '/v1/payments', { key, body: pay('tok_decline') })
    expect(declined.status).toBe(402)
    expect(declined.body).toMatchObject({ error: { code: 'card_declined' }, payment: { status: 'failed', failure_reason: 'card_declined' } })
    expect(await call('POST', '/v1/payments', { key, body: pay('tok_decline') })).toMatchObject({ status: 402, replayed: true })
    expect(await count(admin, 'SELECT count(*)::int AS n FROM journals WHERE external_ref = $1', [`capture:${declined.body.payment.id}`])).toBe(0)
  })

  it('answers 503 when the PSP captures and then hangs, and the retry finishes the same capture once', async () => {
    const key = randomUUID()
    const body = pay('tok_timeout_after_capture')
    const first = await call('POST', '/v1/payments', { key, body })
    expect(first).toMatchObject({ status: 503, retryAfter: '1', body: { error: { code: 'psp_unavailable' } } })
    const second = await call('POST', '/v1/payments', { key, body })
    expect(second).toMatchObject({ status: 200, replayed: false, body: { status: 'captured' } })
    expect(await call('POST', '/v1/payments', { key, body })).toMatchObject({ status: 200, replayed: true })
    const { rows } = await admin.query<{ psp_charge_id: string }>('SELECT psp_charge_id FROM payments WHERE id = $1', [second.body.id])
    const chargeId = rows[0]!.psp_charge_id
    expect(await count(pspSql, `SELECT count(*)::int AS n FROM operations WHERE kind = 'capture' AND charge_id = $1`, [chargeId])).toBe(1)
    expect(await count(admin, 'SELECT count(*)::int AS n FROM journals WHERE external_ref = $1', [`capture:${second.body.id}`])).toBe(1)
  })

  it('recovers from a PSP that failed before doing anything, and from one that dropped the connection', async () => {
    for (const token of ['tok_fail_once_capture', 'tok_drop_after_authorize']) {
      const key = randomUUID()
      expect((await call('POST', '/v1/payments', { key, body: pay(token) })).status).toBe(503)
      expect(await call('POST', '/v1/payments', { key, body: pay(token) })).toMatchObject({ status: 200, body: { status: 'captured' } })
    }
  })

  it('refuses a key whose lease is alive and takes over one whose owner went away', async () => {
    const key = randomUUID()
    const body = pay('tok_ok', { amount: 700 })
    await owner.query(
      `INSERT INTO idempotency_keys (client_id, key, method, path, request_hash, locked_until)
       VALUES ($1, $2, 'POST', '/v1/payments', $3, now() + interval '30 seconds')`,
      [clientIds.alice, key, requestHash('POST', '/v1/payments', body)],
    )
    expect(await call('POST', '/v1/payments', { key, body })).toMatchObject({
      status: 409,
      retryAfter: '1',
      body: { error: { code: 'request_in_progress' } },
    })
    await owner.query(`UPDATE idempotency_keys SET locked_until = now() - interval '1 second' WHERE key = $1`, [key])
    expect(await call('POST', '/v1/payments', { key, body })).toMatchObject({ status: 200, body: { amount: 700, status: 'captured' } })
  })

  it('authorizes, captures part of a manual payment, and refuses a second capture without storing it', async () => {
    const created = await call('POST', '/v1/payments', { body: pay('tok_ok', { capture: 'manual' }) })
    expect(created.body).toMatchObject({ status: 'authorized', captured_amount: 0 })
    const captured = await call('POST', `/v1/payments/${created.body.id}/capture`, { body: { amount: 1000 } })
    expect(captured.body).toMatchObject({ status: 'captured', captured_amount: 1000, fee: 30 })
    const key = randomUUID()
    const again = await call('POST', `/v1/payments/${created.body.id}/capture`, { key, body: {} })
    expect(again).toMatchObject({ status: 409, body: { error: { code: 'payment_not_capturable' } } })
    expect(await call('POST', `/v1/payments/${created.body.id}/capture`, { key, body: {} })).toMatchObject({ status: 409, replayed: false })
    expect((await call('POST', `/v1/payments/${created.body.id}/cancel`)).status).toBe(409)
  })

  it('cancels an authorization without touching the ledger', async () => {
    const created = await call('POST', '/v1/payments', { body: pay('tok_ok', { capture: 'manual' }) })
    expect((await call('POST', `/v1/payments/${created.body.id}/cancel`)).body).toMatchObject({ status: 'canceled' })
    expect(await count(admin, 'SELECT count(*)::int AS n FROM journals WHERE external_ref = $1', [`capture:${created.body.id}`])).toBe(0)
  })

  it('refunds in parts, gives back the fee in proportion, and stops at the captured amount', async () => {
    const before = await balance('merchant_payable:wash_2')
    const fees = await balance('platform_fee_revenue:EUR')
    const payment = (await call('POST', '/v1/payments', { body: pay('tok_ok', { merchant: 'wash_2' }) })).body
    const first = await call('POST', `/v1/payments/${payment.id}/refunds`, { body: { amount: 500 } })
    expect(first.body).toMatchObject({ object: 'refund', status: 'succeeded', amount: 500, fee_refund: 13 })
    const second = await call('POST', `/v1/payments/${payment.id}/refunds`, { body: { amount: 1000 } })
    expect(second.body).toMatchObject({ status: 'succeeded', fee_refund: 27 })
    expect((await call('GET', `/v1/payments/${payment.id}`)).body).toMatchObject({ status: 'refunded', refunded_amount: 1500 })
    expect(await balance('merchant_payable:wash_2')).toBe(before)
    expect(await balance('platform_fee_revenue:EUR')).toBe(fees)
    const more = await call('POST', `/v1/payments/${payment.id}/refunds`, { body: { amount: 1 } })
    expect(more).toMatchObject({ status: 409, body: { error: { code: 'payment_not_refundable' } } })
  })

  it('pays a merchant out only up to what it is owed, checked under its lock', async () => {
    await call('POST', '/v1/payments', { body: pay('tok_ok', { merchant: 'wash_2', amount: 5000 }) })
    const payable = (await call('GET', '/v1/merchants/wash_2', { as: 'admin' })).body.payable
    expect(payable).toBeGreaterThanOrEqual(4890)
    const tooMuch = await call('POST', '/v1/payouts', { as: 'admin', body: { merchant: 'wash_2', amount: payable + 1, currency: 'EUR' } })
    expect(tooMuch).toMatchObject({ status: 409, body: { error: { code: 'insufficient_funds' } } })
    const bank = await balance('bank:EUR')
    const paid = await call('POST', '/v1/payouts', { as: 'admin', body: { merchant: 'wash_2', amount: payable, currency: 'EUR' } })
    expect(paid.body).toMatchObject({ object: 'payout', status: 'succeeded', amount: payable })
    expect((await call('GET', '/v1/merchants/wash_2', { as: 'admin' })).body.payable).toBe(0)
    expect(await balance('bank:EUR')).toBe(bank - payable)
    expect((await call('POST', '/v1/payouts', { body: { merchant: 'wash_2', amount: 1, currency: 'EUR' } })).status).toBe(403)
  })

  it('checks keys, scopes, ownership and input before doing anything', async () => {
    expect((await call('GET', '/health', { as: 'nobody' })).status).toBe(200)
    expect((await call('POST', '/v1/payments', { as: 'nobody', body: pay('tok_ok') })).status).toBe(401)
    const mine = (await call('POST', '/v1/payments', { body: pay('tok_ok') })).body
    expect((await call('GET', `/v1/payments/${mine.id}`, { as: 'bob' })).status).toBe(404)
    expect((await call('GET', `/v1/payments/${mine.id}`, { as: 'admin' })).status).toBe(200)
    expect((await call('POST', '/v1/payments', { key: null, body: pay('tok_ok') })).status).toBe(400)
    const key = randomUUID()
    expect((await call('POST', '/v1/payments', { key, body: pay('tok_ok', { amount: 1.5 }) })).status).toBe(400)
    expect((await call('POST', '/v1/payments', { key, body: pay('tok_ok', { card: '4242' }) })).status).toBe(400)
    expect((await call('POST', '/v1/payments', { key, body: pay('tok_ok', { merchant: 'nobody' }) })).status).toBe(404)
    expect((await call('POST', '/v1/payments', { key, body: pay('tok_ok', { amount: 10 }) })).body.error.code).toBe('amount_too_small')
    expect((await call('POST', '/v1/payments', { key, body: pay('tok_ok') })).status).toBe(200)
    expect((await call('GET', '/v1/payments/not-a-uuid')).status).toBe(400)
  })

  it('does not apply a PSP answer that does not match the request, and records it', async () => {
    const liar: Server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: `op_${randomUUID()}`,
          object: 'operation',
          idempotency_key: request.headers['idempotency-key'],
          kind: 'authorize',
          status: 'succeeded',
          reason: null,
          amount: body.amount + 100,
          currency: body.currency,
          charge: { id: `ch_${randomUUID()}`, authorized_amount: body.amount + 100 },
        }),
      )
    })
    liar.listen(0, '127.0.0.1')
    await once(liar, 'listening')
    const lied = await startApi(config(`http://127.0.0.1:${(liar.address() as AddressInfo).port}`))
    try {
      const reply = await call('POST', '/v1/payments', { base: lied.url, body: pay('tok_ok', { amount: 900 }) })
      expect(reply).toMatchObject({ status: 502, body: { error: { code: 'psp_answer_rejected' } } })
      const { rows } = await admin.query<{ kind: string; problems: string[]; status: string }>(
        `SELECT an.kind, an.details->'problems' AS problems, a.status::text FROM anomalies an JOIN attempts a ON a.id = an.attempt_id
         JOIN payments p ON p.id = a.payment_id WHERE p.amount = 900 AND p.token = 'tok_ok'`,
      )
      expect(rows).toEqual([
        {
          kind: 'answer_mismatch',
          problems: ['amount is 1000, expected 900', 'charge.authorized_amount is 1000, expected 900'],
          status: 'pending',
        },
      ])
    } finally {
      await lied.app.close()
      liar.close()
    }
  })

  it('caps how long any of its transactions may stay open', async () => {
    const { rows } = await app.get(Database).pool.query<{ transaction_timeout: string; idle_in_transaction_session_timeout: string }>(
      `SELECT current_setting('transaction_timeout') AS transaction_timeout,
              current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout`,
    )
    expect(rows[0]).toEqual({ transaction_timeout: '10s', idle_in_transaction_session_timeout: '10s' })
  })

  it('leaves the books balanced and agreeing with the PSP', async () => {
    expect(violations(await checkLedger(admin))).toEqual([])
    const pspCaptures = await count(pspSql, `SELECT count(*)::int AS n FROM operations WHERE kind = 'capture' AND status = 'succeeded'`)
    const journals = await count(admin, `SELECT count(*)::int AS n FROM journals WHERE external_ref LIKE 'capture:%'`)
    expect(journals).toBe(pspCaptures)
  })
})
