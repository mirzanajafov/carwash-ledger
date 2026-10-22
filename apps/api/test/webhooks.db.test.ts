import { createHmac, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { checkAgainstPsp, checkLedger, checkPayments, violations } from '@carwash/invariants'
import { firstRow } from '@carwash/pg'
import { NO_FAULTS } from '@carwash/psp'
import type { INestApplication, INestApplicationContext } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Database } from '../src/db/database.ts'
import { findAttempt } from '../src/payments/attempts.repository.ts'
import { WebhooksService } from '../src/webhooks/webhooks.service.ts'
import { Recovery } from '../src/worker/recovery.service.ts'
import { WorkerModule } from '../src/worker/worker.module.ts'
import { count, startStack, WEBHOOK_SECRET, type CallOptions, type Reply, type Stack } from './support.ts'

let stack: Stack
let worker: INestApplicationContext
let recovery: Recovery

function call(method: string, path: string, options?: CallOptions) {
  return stack.call(method, path, options)
}

function pay(token: string, extra: Record<string, unknown> = {}) {
  return { amount: 1500, currency: 'EUR', merchant: 'wash_1', token, ...extra }
}

function sign(body: string, secret = WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000)): string {
  return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`
}

async function postWebhook(body: string, signature: string | undefined): Promise<Reply> {
  const response = await fetch(`${stack.url}/webhooks/psp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature === undefined ? {} : { 'psp-signature': signature }) },
    body,
  })
  return { status: response.status, body: await response.json(), replayed: false, retryAfter: null }
}

function event(attemptKey: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: `evt_${randomUUID()}`,
    object: 'event',
    type: 'operation.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: { object: { idempotency_key: attemptKey, status: 'succeeded', ...extra } },
  })
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await sleep(50)
  }
}

async function paymentStatus(id: string): Promise<string> {
  return (await call('GET', `/v1/payments/${id}`)).body.status
}

async function paymentIdForKey(key: string): Promise<string> {
  return firstRow(await stack.admin.query<{ payment_id: string }>('SELECT payment_id FROM idempotency_keys WHERE key = $1', [key])).payment_id
}

async function attemptOf(paymentId: string, kind: string): Promise<string> {
  return firstRow(await stack.admin.query<{ id: string }>('SELECT id FROM attempts WHERE payment_id = $1 AND kind = $2::attempt_kind', [paymentId, kind])).id
}

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  stack = await startStack({ webhooks: true })
  cleanup.defer(() => stack.close())
  worker = await NestFactory.createApplicationContext(WorkerModule.register({ ...stack.config, recoveryEveryMs: 0 }), { logger: false })
  cleanup.defer(() => worker.close())
  recovery = worker.get(Recovery)
})

afterAll(() => cleanup.disposeAsync())

beforeEach(() => {
  stack.psp.faults.plan = NO_FAULTS
})

describe('webhooks', () => {
  it('finish a capture whose client gave up after the PSP went quiet', async () => {
    const key = randomUUID()
    expect((await call('POST', '/v1/payments', { key, body: pay('tok_timeout_after_capture') })).status).toBe(503)
    const paymentId = await paymentIdForKey(key)
    await waitFor(async () => ((await paymentStatus(paymentId)) === 'captured' ? true : undefined))
    const capture = await attemptOf(paymentId, 'capture')
    const { rows } = await stack.admin.query<{ outcome: string }>('SELECT outcome FROM webhook_events WHERE attempt_id = $1', [capture])
    expect(rows.map((r) => r.outcome)).toContain('applied')
    expect(await call('POST', '/v1/payments', { key, body: pay('tok_timeout_after_capture') })).toMatchObject({
      status: 200,
      body: { status: 'captured' },
    })
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM journals WHERE external_ref = $1', [`capture:${paymentId}`])).toBe(1)
  })

  it('are recorded once per event however many times they arrive', async () => {
    const payment = (await call('POST', '/v1/payments', { body: pay('tok_webhook_duplicate') })).body
    const { psp_charge_id: chargeId } = firstRow(
      await stack.admin.query<{ psp_charge_id: string }>('SELECT psp_charge_id FROM payments WHERE id = $1', [payment.id]),
    )
    const deliveries = await waitFor(async () => {
      const { rows } = await stack.pspSql.query<{ event_id: string; delivered: number }>(
        `SELECT d.event_id, count(*) FILTER (WHERE d.delivered_at IS NOT NULL)::int AS delivered
         FROM deliveries d JOIN events e ON e.id = d.event_id JOIN operations o ON o.id = e.operation_id
         WHERE o.charge_id = $1 GROUP BY d.event_id`,
        [chargeId],
      )
      return rows.length === 2 && rows.every((r) => r.delivered === 2) ? rows : undefined
    }, 20_000)
    const events = deliveries.map((d) => d.event_id)
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM webhook_events WHERE id = ANY($1)', [events])).toBe(2)
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM journals WHERE external_ref = $1', [`capture:${payment.id}`])).toBe(1)
  })

  it('refuse a missing, wrong, stale or tampered signature', async () => {
    const body = event(randomUUID())
    const id = JSON.parse(body).id
    expect((await postWebhook(body, undefined)).body.error.code).toBe('invalid_signature')
    expect((await postWebhook(body, sign(body, 'whsec_wrong'))).status).toBe(400)
    expect((await postWebhook(body, sign(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 600))).status).toBe(400)
    expect((await postWebhook(body.replace('succeeded', 'declined'), sign(body))).status).toBe(400)
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM webhook_events WHERE id = $1', [id])).toBe(0)
  })

  it('park an event for an attempt the ledger does not know, and report it once it is overdue', async () => {
    const body = event(randomUUID())
    const id = JSON.parse(body).id
    expect((await postWebhook(body, sign(body))).body).toEqual({ received: true, outcome: 'unmatched' })
    expect((await postWebhook(body, sign(body))).body).toEqual({ received: true, outcome: 'unmatched', duplicate: true })
    await stack.owner.query(`UPDATE webhook_events SET received_at = now() - interval '2 hours', checked_at = now() - interval '1 minute' WHERE id = $1`, [id])
    await worker.get(WebhooksService).recheckUnmatched(3600)
    const { rows } = await stack.admin.query<{ outcome: string; checks: number }>('SELECT outcome, checks FROM webhook_events WHERE id = $1', [id])
    expect(rows).toEqual([{ outcome: 'reported', checks: 2 }])
    expect(await count(stack.admin, `SELECT count(*)::int AS n FROM anomalies WHERE kind = 'unmatched_webhook' AND details->>'event' = $1`, [id])).toBe(1)
  })

  it('are only a hint: a signed claim that the PSP cannot back changes nothing', async () => {
    const payment = (await call('POST', '/v1/payments', { body: pay('tok_fail_capture', { capture: 'manual' }) })).body
    expect((await call('POST', `/v1/payments/${payment.id}/capture`, { body: {} })).status).toBe(503)
    const capture = await attemptOf(payment.id, 'capture')
    const body = event(capture, { kind: 'capture', amount: 1500, currency: 'EUR' })
    expect((await postWebhook(body, sign(body))).body).toEqual({ received: true, outcome: 'not_at_psp' })
    expect(await paymentStatus(payment.id)).toBe('authorized')
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM journals WHERE external_ref = $1', [`capture:${payment.id}`])).toBe(0)
  })
})

describe('the recovery job', () => {
  it('sends an attempt the PSP never saw and applies the answer', async () => {
    const key = randomUUID()
    expect((await call('POST', '/v1/payments', { key, body: pay('tok_fail_once_capture') })).status).toBe(503)
    const paymentId = await paymentIdForKey(key)
    const attempt = await findAttempt(stack.admin, await attemptOf(paymentId, 'capture'))
    assert(attempt)
    expect(attempt.status).toBe('pending')
    expect(await recovery.recover(attempt)).toBe('applied')
    expect(await paymentStatus(paymentId)).toBe('captured')
    expect(await call('POST', '/v1/payments', { key, body: pay('tok_fail_once_capture') })).toMatchObject({ status: 200, body: { status: 'captured' } })
  })

  it('applies what the PSP did when the webhook was lost', async () => {
    stack.psp.faults.plan = { ...NO_FAULTS, webhook: { duplicate: 0, delay: 0, reorder: 0, drop: 1 } }
    const key = randomUUID()
    expect((await call('POST', '/v1/payments', { key, body: pay('tok_timeout_after_capture') })).status).toBe(503)
    const paymentId = await paymentIdForKey(key)
    await sleep(300)
    expect(await paymentStatus(paymentId)).toBe('authorized')
    const outcomes = await recovery.recoverPending(0)
    expect(outcomes.get('applied')).toBeGreaterThanOrEqual(1)
    expect(await paymentStatus(paymentId)).toBe('captured')
  })

  it('runs on its own in the worker process, which answers health and nothing else', async () => {
    const live: INestApplication = await NestFactory.create(WorkerModule.register({ ...stack.config, recoveryEveryMs: 200, recoveryAfterSeconds: 0 }), {
      logger: false,
    })
    await live.listen(0, '127.0.0.1')
    try {
      const base = `http://127.0.0.1:${(live.getHttpServer().address() as AddressInfo).port}`
      expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true, pid: process.pid })
      for (const path of ['/v1/admin/anomalies', `/v1/payments/${randomUUID()}`, '/v1/reconciliation/days', '/v1/audit/head']) {
        expect((await fetch(`${base}${path}`)).status).toBe(404)
      }
      const key = randomUUID()
      expect((await call('POST', '/v1/payments', { key, body: pay('tok_fail_once_capture') })).status).toBe(503)
      const paymentId = await paymentIdForKey(key)
      await waitFor(async () => ((await paymentStatus(paymentId)) === 'captured' ? true : undefined))
    } finally {
      await live.close()
    }
  })

  it('stops its loops before the database pools close when the worker shuts down', async () => {
    const stopping = vi.spyOn(Recovery.prototype, 'onModuleDestroy')
    const closing = vi.spyOn(Database.prototype, 'onModuleDestroy')
    try {
      const worker = await NestFactory.createApplicationContext(WorkerModule.register({ ...stack.config, recoveryEveryMs: 10 }), { logger: false })
      await worker.close()
      const [stopped] = stopping.mock.invocationCallOrder
      const [closed] = closing.mock.invocationCallOrder
      assert(stopped !== undefined && closed !== undefined)
      expect(stopped).toBeLessThan(closed)
    } finally {
      stopping.mockRestore()
      closing.mockRestore()
    }
  })

  it('leaves an attempt whose answer it refused for a person, instead of asking again forever', async () => {
    const key = randomUUID()
    expect((await call('POST', '/v1/payments', { key, body: pay('tok_wrong_amount_capture') })).body.error.code).toBe('psp_answer_rejected')
    const capture = await attemptOf(await paymentIdForKey(key), 'capture')
    const outcomes = await recovery.recoverPending(0)
    expect(outcomes.get('anomaly')).toBeUndefined()
    const attempt = await findAttempt(stack.admin, capture)
    assert(attempt)
    expect(attempt).toMatchObject({ status: 'pending' })
    expect(await recovery.recover(attempt)).toBe('anomaly')
    expect(await count(stack.admin, `SELECT count(*)::int AS n FROM anomalies WHERE attempt_id = $1 AND kind = 'answer_mismatch'`, [capture])).toBe(1)
  })

  it('counts an attempt as unknown while the PSP keeps failing before it does anything', async () => {
    stack.psp.faults.plan = { ...NO_FAULTS, fail: 1 }
    const key = randomUUID()
    expect((await call('POST', '/v1/payments', { key, body: pay('tok_ok') })).body.error.code).toBe('psp_unavailable')
    const attempt = await findAttempt(stack.admin, await attemptOf(await paymentIdForKey(key), 'authorize'))
    assert(attempt)
    expect(await recovery.recover(attempt)).toBe('unknown')
    stack.psp.faults.plan = NO_FAULTS
    expect(await recovery.recover(attempt)).toBe('applied')
  })

  it('leaves the books balanced and agreeing with the PSP', async () => {
    expect(violations(await checkLedger(stack.admin))).toEqual([])
    expect(violations(await checkPayments(stack.admin))).toEqual([])
    expect(violations([await checkAgainstPsp(stack.admin, stack.pspSql)])).toEqual([])
  })
})
