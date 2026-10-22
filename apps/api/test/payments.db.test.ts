import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { checkAgainstPsp, checkLedger, checkPayments, checkSettled, violations } from '@carwash/invariants'
import { firstRow } from '@carwash/pg'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { Database } from '../src/db/database.ts'
import { IdempotencyService, type Begun, type OwnedKey } from '../src/idempotency/idempotency.service.ts'
import { requestHash } from '../src/idempotency/request-hash.ts'
import { PaymentsService } from '../src/payments/payments.service.ts'
import { apiConfig, count, startApi, startStack, type CallOptions, type Stack } from './support.ts'

let stack: Stack

function call(method: string, path: string, options?: CallOptions) {
  return stack.call(method, path, options)
}

function pay(token: string, extra: Record<string, unknown> = {}) {
  return { amount: 1500, currency: 'EUR', merchant: 'wash_1', token, ...extra }
}

function owned(begun: Begun): OwnedKey {
  if (begun.kind !== 'owned') throw new Error('expected to own the key')
  return begun.owned
}

async function balance(code: string): Promise<number> {
  const reply = await call('GET', `/v1/accounts/${encodeURIComponent(code)}/balance`)
  return reply.body.balance
}

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  stack = await startStack()
  cleanup.defer(() => stack.close())
})

afterAll(() => cleanup.disposeAsync())

describe('payments API', () => {
  it('authorizes and captures a payment, and posts one balanced capture journal', async () => {
    const reply = await call('POST', '/v1/payments', { body: pay('tok_ok') })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ object: 'payment', status: 'captured', amount: 1500, captured_amount: 1500, fee: 40 })
    const { rows } = await stack.admin.query<{ account: string; amount: string }>(
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
    const [paid] = done
    assert(paid)
    const settled = await call('POST', '/v1/payments', { key, body })
    expect(settled).toMatchObject({ status: 200, replayed: true, body: { id: paid.body.id } })
    expect(await count(stack.admin, `SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`, [key])).toBe(1)
    expect(await count(stack.admin, `SELECT count(*)::int AS n FROM journals WHERE external_ref = $1`, [`capture:${paid.body.id}`])).toBe(1)
  })

  it('stores a decline as a 402 and replays it', async () => {
    const key = randomUUID()
    const declined = await call('POST', '/v1/payments', { key, body: pay('tok_decline') })
    expect(declined.status).toBe(402)
    expect(declined.body).toMatchObject({ error: { code: 'card_declined' }, payment: { status: 'failed', failure_reason: 'card_declined' } })
    expect(await call('POST', '/v1/payments', { key, body: pay('tok_decline') })).toMatchObject({ status: 402, replayed: true })
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM journals WHERE external_ref = $1', [`capture:${declined.body.payment.id}`])).toBe(0)
  })

  it('answers 503 when the PSP captures and then hangs, and the retry finishes the same capture once', async () => {
    const key = randomUUID()
    const body = pay('tok_timeout_after_capture')
    const first = await call('POST', '/v1/payments', { key, body })
    expect(first).toMatchObject({ status: 503, retryAfter: '1', body: { error: { code: 'psp_unavailable' } } })
    const second = await call('POST', '/v1/payments', { key, body })
    expect(second).toMatchObject({ status: 200, replayed: false, body: { status: 'captured' } })
    expect(await call('POST', '/v1/payments', { key, body })).toMatchObject({ status: 200, replayed: true })
    const { psp_charge_id: chargeId } = firstRow(
      await stack.admin.query<{ psp_charge_id: string }>('SELECT psp_charge_id FROM payments WHERE id = $1', [second.body.id]),
    )
    expect(await count(stack.pspSql, `SELECT count(*)::int AS n FROM operations WHERE kind = 'capture' AND charge_id = $1`, [chargeId])).toBe(1)
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM journals WHERE external_ref = $1', [`capture:${second.body.id}`])).toBe(1)
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
    await stack.owner.query(
      `INSERT INTO idempotency_keys (client_id, key, method, path, request_hash, locked_until)
       VALUES ($1, $2, 'POST', '/v1/payments', $3, now() + interval '30 seconds')`,
      [stack.clientIds.alice, key, requestHash('POST', '/v1/payments', body)],
    )
    expect(await call('POST', '/v1/payments', { key, body })).toMatchObject({
      status: 409,
      retryAfter: '1',
      body: { error: { code: 'request_in_progress' } },
    })
    await stack.owner.query(`UPDATE idempotency_keys SET locked_until = now() - interval '1 second' WHERE key = $1`, [key])
    expect(await call('POST', '/v1/payments', { key, body })).toMatchObject({ status: 200, body: { amount: 700, status: 'captured' } })
  })

  it('lets only the request holding the lease create anything with a key, so a slow owner cannot add a second payment', async () => {
    const idempotency = stack.app.get(IdempotencyService)
    const payments = stack.app.get(PaymentsService)
    const key = randomUUID()
    const body = { amount: 813, currency: 'EUR', merchant: 'wash_1', token: 'tok_ok', capture: 'auto' as const }
    const slow = owned(await idempotency.begin(stack.clientIds.alice, key, 'POST', '/v1/payments', body))
    await stack.owner.query(`UPDATE idempotency_keys SET locked_until = now() - interval '1 second' WHERE key = $1`, [key])
    const retry = owned(await idempotency.begin(stack.clientIds.alice, key, 'POST', '/v1/payments', body))
    await expect(payments.create(slow, body)).rejects.toMatchObject({ failure: 'conflict', code: 'request_in_progress' })
    expect((await payments.create(retry, body)).body).toMatchObject({ amount: 813, status: 'captured' })
    await idempotency.abandon(slow)
    const { rows } = await stack.admin.query<{ id: string }>(`SELECT p.id FROM payments p JOIN idempotency_keys k ON k.key = $1 WHERE p.amount = 813`, [key])
    expect(rows).toHaveLength(1)
    const [payment] = rows
    assert(payment)
    expect(await call('POST', '/v1/payments', { key, body })).toMatchObject({ status: 200, replayed: true, body: { id: payment.id } })
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

  it('finishes a manual capture the PSP did before hanging when the client retries it with the same key', async () => {
    const created = await call('POST', '/v1/payments', { body: pay('tok_timeout_after_capture', { capture: 'manual' }) })
    expect(created.body).toMatchObject({ status: 'authorized' })
    const key = randomUUID()
    const capture = `/v1/payments/${created.body.id}/capture`
    expect(await call('POST', capture, { key, body: {} })).toMatchObject({ status: 503, body: { error: { code: 'psp_unavailable' } } })
    expect(await call('POST', capture, { key, body: {} })).toMatchObject({ status: 200, replayed: false, body: { status: 'captured' } })
    expect(await count(stack.admin, `SELECT count(*)::int AS n FROM attempts WHERE payment_id = $1 AND kind = 'capture'`, [created.body.id])).toBe(1)
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM journals WHERE external_ref = $1', [`capture:${created.body.id}`])).toBe(1)
  })

  it('finishes a cancel the PSP did before hanging when the client retries it with the same key', async () => {
    const created = await call('POST', '/v1/payments', { body: pay('tok_timeout_after_cancel', { capture: 'manual' }) })
    expect(created.body).toMatchObject({ status: 'authorized' })
    const key = randomUUID()
    const cancel = `/v1/payments/${created.body.id}/cancel`
    expect(await call('POST', cancel, { key })).toMatchObject({ status: 503, body: { error: { code: 'psp_unavailable' } } })
    expect(await call('POST', cancel, { key })).toMatchObject({ status: 200, replayed: false, body: { status: 'canceled' } })
    expect(await count(stack.admin, `SELECT count(*)::int AS n FROM attempts WHERE payment_id = $1 AND kind = 'cancel'`, [created.body.id])).toBe(1)
  })

  it('cancels an authorization without touching the ledger', async () => {
    const created = await call('POST', '/v1/payments', { body: pay('tok_ok', { capture: 'manual' }) })
    expect((await call('POST', `/v1/payments/${created.body.id}/cancel`)).body).toMatchObject({ status: 'canceled' })
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM journals WHERE external_ref = $1', [`capture:${created.body.id}`])).toBe(0)
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

  it('writes an event for every state change and every entry, in the transaction that makes it', async () => {
    const payment = (await call('POST', '/v1/payments', { body: pay('tok_ok') })).body
    await call('POST', `/v1/payments/${payment.id}/refunds`, { body: { amount: 600 } })
    await call('POST', `/v1/payments/${payment.id}/refunds`, { body: { amount: 900 } })
    const declined = (await call('POST', '/v1/payments', { body: pay('tok_decline') })).body.payment
    const events = async (key: string) =>
      (
        await stack.admin.query<{ type: string; status: string }>(
          `SELECT type, payload->>'status' AS status FROM outbox WHERE topic = 'payments' AND key = $1 ORDER BY id`,
          [key],
        )
      ).rows
    expect(await events(payment.id)).toEqual([
      { type: 'payment.authorized', status: 'authorized' },
      { type: 'payment.captured', status: 'captured' },
      { type: 'refund.succeeded', status: 'succeeded' },
      { type: 'refund.succeeded', status: 'succeeded' },
      { type: 'payment.refunded', status: 'refunded' },
    ])
    expect(await events(declined.id)).toEqual([{ type: 'payment.failed', status: 'failed' }])
    const { rows } = await stack.admin.query<{ external_ref: string; entries: number; events: number }>(
      `SELECT j.external_ref, count(DISTINCT e.id)::int AS entries, count(o.id)::int AS events
       FROM journals j
       JOIN entries e ON e.journal_id = j.id
       LEFT JOIN outbox o ON o.topic = 'ledger' AND o.key = e.account_id::text AND o.payload->>'entry_id' = e.id::text
       GROUP BY j.external_ref`,
    )
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.filter((row) => row.entries !== row.events)).toEqual([])
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
    const nothing = await call('POST', '/v1/payouts', { as: 'admin', body: { merchant: 'wash_2', currency: 'EUR' } })
    expect(nothing).toMatchObject({ status: 409, body: { error: { code: 'nothing_to_pay_out' } } })
    await call('POST', '/v1/payments', { body: pay('tok_ok', { merchant: 'wash_2', amount: 2000 }) })
    const swept = await call('POST', '/v1/payouts', { as: 'admin', body: { merchant: 'wash_2', currency: 'EUR' } })
    expect(swept.body).toMatchObject({ object: 'payout', status: 'succeeded', amount: 1950 })
    expect((await call('GET', '/v1/merchants/wash_2', { as: 'admin' })).body.payable).toBe(0)
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
    const lied = await startApi(apiConfig(stack.ledgerDb.url('ledger_app'), `http://127.0.0.1:${(liar.address() as AddressInfo).port}`))
    try {
      const reply = await call('POST', '/v1/payments', { base: lied.url, body: pay('tok_ok', { amount: 900 }) })
      expect(reply).toMatchObject({ status: 502, body: { error: { code: 'psp_answer_rejected' } } })
      const { rows } = await stack.admin.query<{ kind: string; problems: string[]; status: string }>(
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

  it('caps how long a transaction may stay open and how long a request waits for a connection', async () => {
    const { rows } = await stack.app.get(Database).pool.query<{ transaction_timeout: string; idle_in_transaction_session_timeout: string }>(
      `SELECT current_setting('transaction_timeout') AS transaction_timeout,
              current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout`,
    )
    expect(rows[0]).toEqual({ transaction_timeout: '10s', idle_in_transaction_session_timeout: '10s' })
    const tight = new Database(apiConfig(stack.ledgerDb.url('ledger_app'), stack.psp.url, { poolSize: 1, connectTimeoutMs: 200 }))
    const held = await tight.pool.connect()
    try {
      const started = Date.now()
      await expect(tight.pool.query('SELECT 1')).rejects.toThrow('timeout')
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      held.release()
      await tight.onModuleDestroy()
    }
  })

  it('answers 503 with Retry-After when it cannot reach the database in time, and the same key works once it can', async () => {
    const { app, url } = await startApi(apiConfig(stack.ledgerDb.url('ledger_app'), stack.psp.url, { poolSize: 1, connectTimeoutMs: 200 }))
    const key = randomUUID()
    try {
      const held = await app.get(Database).pool.connect()
      try {
        const busy = await call('POST', '/v1/payments', { base: url, key, body: pay('tok_ok') })
        expect(busy.status).toBe(503)
        expect(busy.body.error.code).toBe('database_unavailable')
        expect(busy.retryAfter).toBe('1')
      } finally {
        held.release()
      }
      const served = await call('POST', '/v1/payments', { base: url, key, body: pay('tok_ok') })
      expect(served.status).toBe(200)
      expect(served.body.status).toBe('captured')
    } finally {
      await app.close()
    }
  })

  it('leaves the books balanced and agreeing with the PSP', async () => {
    expect(violations(await checkLedger(stack.admin))).toEqual([])
    expect(violations(await checkPayments(stack.admin))).toEqual([])
    expect(violations([await checkAgainstPsp(stack.admin, stack.pspSql), await checkSettled(stack.admin)])).toEqual([])
  })
})
