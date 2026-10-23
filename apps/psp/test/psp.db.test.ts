import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { text } from 'node:stream/consumers'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { createScratchDatabase } from '@carwash/testkit'
import pg from 'pg'
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as z from 'zod/mini'
import { startPsp, type RunningPsp } from '../src/app.ts'
import { NO_FAULTS } from '../src/faults.ts'
import { verifySignature } from '../src/signature.ts'

const API_KEY = 'sk_test_psp'
const ADMIN_KEY = 'sk_admin_psp'
const SECRET = 'whsec_psp'

interface Received {
  signature: string
  body: string
}

const Operation = z.object({ id: z.string(), charge: z.nullable(z.object({ id: z.string() })) })
const Delivery = z.object({ id: z.string(), data: z.object({ object: z.object({ id: z.string(), charge: z.nullish(z.object({ id: z.string() })) }) }) })
const WeatherReply = z.object({ weather: z.nullable(z.object({ until: z.string() })) })
const Calendar = z.object({ current_day: z.number() })

function delivered(body: string): z.infer<typeof Delivery> {
  return Delivery.parse(JSON.parse(body))
}

let sql: pg.Pool
let running: RunningPsp
let received: Received[]
let answerWith: (body: string) => number

interface Reply {
  status: number
  body: unknown
  replayed: boolean
}

async function call(method: string, path: string, options: { key?: string; body?: unknown; auth?: string; timeoutMs?: number } = {}): Promise<Reply> {
  const response = await fetch(`${running.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${options.auth ?? API_KEY}`,
      'content-type': 'application/json',
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    },
    body: options.body === undefined ? null : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  })
  const body: unknown = await response.json()
  return { status: response.status, body, replayed: response.headers.get('idempotent-replayed') === 'true' }
}

async function authorize(token = 'tok_ok', amount = 1500): Promise<string> {
  const reply = await call('POST', '/v1/charges', { key: randomUUID(), body: { amount, currency: 'EUR', token } })
  expect(reply.status).toBe(200)
  const { charge } = Operation.parse(reply.body)
  assert(charge)
  return charge.id
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

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  const db = await createScratchDatabase('psp')
  cleanup.defer(() => db.drop())
  sql = new pg.Pool({ connectionString: db.url, max: 2 })
  cleanup.defer(() => sql.end())
  received = []
  const receiver = createServer((request, response) => {
    void text(request).then((body) => {
      received.push({ signature: String(request.headers['psp-signature']), body })
      response.writeHead(answerWith(body)).end()
    })
  })
  receiver.listen(0, '127.0.0.1')
  await once(receiver, 'listening')
  cleanup.defer(() => {
    receiver.closeAllConnections()
    receiver.close()
  })
  running = await startPsp(
    {
      port: 0,
      databaseUrl: db.url,
      apiKey: API_KEY,
      adminKey: ADMIN_KEY,
      webhook: { url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhooks/psp`, secret: SECRET },
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
  cleanup.defer(() => running.close())
})

afterAll(() => cleanup.disposeAsync())

beforeEach(() => {
  running.faults.plan = NO_FAULTS
  answerWith = () => 200
})

describe('PSP simulator', () => {
  it('authorizes, captures and refunds, and refuses to refund more than was captured', async () => {
    const chargeId = await authorize('tok_ok', 1500)
    const capture = await call('POST', `/v1/charges/${chargeId}/capture`, { key: randomUUID(), body: {} })
    expect(capture.body).toMatchObject({ kind: 'capture', status: 'succeeded', amount: 1500, charge: { status: 'captured' } })
    const refund = await call('POST', `/v1/charges/${chargeId}/refunds`, { key: randomUUID(), body: { amount: 1000 } })
    expect(refund.body).toMatchObject({ kind: 'refund', status: 'succeeded', amount: 1000, charge: { refunded_amount: 1000 } })
    const tooMuch = await call('POST', `/v1/charges/${chargeId}/refunds`, { key: randomUUID(), body: { amount: 501 } })
    expect(tooMuch.status).toBe(409)
    expect(tooMuch.body).toMatchObject({ status: 'declined', reason: 'refund_exceeds_captured' })
    const charge = await call('GET', `/v1/charges/${chargeId}`)
    expect(charge.body).toMatchObject({ status: 'captured', authorized_amount: 1500, captured_amount: 1500, refunded_amount: 1000 })
    const again = await call('POST', `/v1/charges/${chargeId}/capture`, { key: randomUUID(), body: {} })
    expect(again.body).toMatchObject({ status: 'declined', reason: 'charge_already_captured' })
  })

  it('replays the stored answer for the same key and body, and rejects the same key with a different body', async () => {
    const key = randomUUID()
    const first = await call('POST', '/v1/charges', { key, body: { amount: 700, currency: 'EUR', token: 'tok_ok' } })
    const second = await call('POST', '/v1/charges', { key, body: { currency: 'EUR', token: 'tok_ok', amount: 700 } })
    expect(second).toEqual({ ...first, replayed: true })
    const reused = await call('POST', '/v1/charges', { key, body: { amount: 701, currency: 'EUR', token: 'tok_ok' } })
    expect(reused).toMatchObject({ status: 422, body: { error: { code: 'idempotency_key_reused' } } })
  })

  it('does one thing for many concurrent requests with one key', async () => {
    const key = randomUUID()
    const replies = await Promise.all(
      Array.from({ length: 20 }, () => call('POST', '/v1/charges', { key, body: { amount: 900, currency: 'EUR', token: 'tok_ok' } })),
    )
    expect(new Set(replies.map((r) => Operation.parse(r.body).id)).size).toBe(1)
    expect(replies.filter((r) => !r.replayed)).toHaveLength(1)
    const { rows } = await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM operations WHERE idempotency_key = $1', [key])
    expect(rows).toEqual([{ n: 1 }])
  })

  it('stores a decline, replays it, and answers the pull with it', async () => {
    const key = randomUUID()
    const body = { amount: 500, currency: 'EUR', token: 'tok_decline' }
    const declined = await call('POST', '/v1/charges', { key, body })
    expect(declined.status).toBe(402)
    expect(declined.body).toMatchObject({ status: 'declined', reason: 'card_declined', charge: null })
    expect((await call('POST', '/v1/charges', { key, body })).replayed).toBe(true)
    expect((await call('GET', `/v1/operations/${key}`)).body).toMatchObject({ id: Operation.parse(declined.body).id, status: 'declined' })
  })

  it('does nothing when it fails with a 500, so the retry with the same key does the work', async () => {
    const chargeId = await authorize('tok_fail_once_capture')
    const key = randomUUID()
    const failed = await call('POST', `/v1/charges/${chargeId}/capture`, { key, body: {} })
    expect(failed.status).toBe(500)
    expect((await call('GET', `/v1/operations/${key}`)).status).toBe(404)
    expect((await call('GET', `/v1/charges/${chargeId}`)).body).toMatchObject({ status: 'authorized' })
    const retried = await call('POST', `/v1/charges/${chargeId}/capture`, { key, body: {} })
    expect(retried).toMatchObject({ status: 200, replayed: false, body: { status: 'succeeded' } })
  })

  it('captures and then hangs past the client timeout, and the pull and the retry both see the capture', async () => {
    const chargeId = await authorize('tok_timeout_after_capture')
    const key = randomUUID()
    await expect(call('POST', `/v1/charges/${chargeId}/capture`, { key, body: {}, timeoutMs: 300 })).rejects.toThrow()
    expect((await call('GET', `/v1/operations/${key}`)).body).toMatchObject({ status: 'succeeded', charge: { status: 'captured' } })
    expect(await call('POST', `/v1/charges/${chargeId}/capture`, { key, body: {} })).toMatchObject({ status: 200, replayed: true })
  })

  it('captures and then drops the connection', async () => {
    const chargeId = await authorize('tok_drop_after_capture')
    const key = randomUUID()
    await expect(call('POST', `/v1/charges/${chargeId}/capture`, { key, body: {} })).rejects.toThrow()
    expect((await call('GET', `/v1/charges/${chargeId}`)).body).toMatchObject({ status: 'captured' })
  })

  it('declines the capture of an expired authorization', async () => {
    const chargeId = await authorize('tok_expire_authorization')
    const capture = await call('POST', `/v1/charges/${chargeId}/capture`, { key: randomUUID(), body: {} })
    expect(capture.status).toBe(402)
    expect(capture.body).toMatchObject({ status: 'declined', reason: 'authorization_expired' })
  })

  it('cancels an authorization once, and never after a capture', async () => {
    const open = await authorize()
    expect((await call('POST', `/v1/charges/${open}/cancel`, { key: randomUUID() })).body).toMatchObject({ status: 'succeeded' })
    const captured = await authorize()
    await call('POST', `/v1/charges/${captured}/capture`, { key: randomUUID(), body: { amount: 1000 } })
    const cancel = await call('POST', `/v1/charges/${captured}/cancel`, { key: randomUUID() })
    expect(cancel.body).toMatchObject({ status: 'declined', reason: 'charge_already_captured', charge: { captured_amount: 1000 } })
  })

  it('sends a signed webhook for every operation and retries until it gets a 2xx', async () => {
    let calls = 0
    answerWith = (body) => (body.includes('merchant_7') && ++calls === 1 ? 500 : 200)
    const key = randomUUID()
    const payout = Operation.parse((await call('POST', '/v1/payouts', { key, body: { amount: 2500, currency: 'EUR', destination: 'merchant_7' } })).body)
    const rows = async () =>
      (
        await sql.query<{ attempts: number; delivered: boolean }>(
          'SELECT attempts, delivered_at IS NOT NULL AS delivered FROM deliveries d JOIN events e ON e.id = d.event_id WHERE e.operation_id = $1',
          [payout.id],
        )
      ).rows
    await expect.poll(rows, { timeout: 10_000 }).toEqual([{ attempts: 2, delivered: true }])
    const deliveries = received.filter((r) => delivered(r.body).data.object.id === payout.id)
    expect(deliveries).toHaveLength(2)
    for (const delivery of deliveries) {
      expect(verifySignature(SECRET, delivery.body, delivery.signature, Math.floor(Date.now() / 1000))).toBe(true)
    }
    const [, redelivered] = deliveries
    assert(redelivered)
    expect(JSON.parse(redelivered.body)).toMatchObject({ type: 'operation.succeeded', data: { object: { kind: 'payout', destination: 'merchant_7' } } })
  })

  it('delivers a duplicated webhook twice with one event id and never sends a dropped one', async () => {
    const duplicated = await authorize('tok_webhook_duplicate')
    const dropped = await authorize('tok_webhook_drop')
    const copies = await waitFor(async () => {
      const mine = received.filter((r) => delivered(r.body).data.object.charge?.id === duplicated)
      return mine.length >= 2 ? mine : undefined
    }, 15_000)
    expect(new Set(copies.map((c) => delivered(c.body).id)).size).toBe(1)
    expect(received.some((r) => delivered(r.body).data.object.charge?.id === dropped)).toBe(false)
    const { rows } = await sql.query(
      `SELECT d.dropped FROM deliveries d JOIN events e ON e.id = d.event_id JOIN operations o ON o.id = e.operation_id WHERE o.charge_id = $1`,
      [dropped],
    )
    expect(rows).toEqual([{ dropped: true }])
  })

  it('treats a key as new once its window has passed', async () => {
    const key = randomUUID()
    await call('POST', '/v1/charges', { key, body: { amount: 300, currency: 'EUR', token: 'tok_ok' } })
    await sql.query(`UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = $1`, [key])
    const reused = await call('POST', '/v1/charges', { key, body: { amount: 301, currency: 'EUR', token: 'tok_ok' } })
    expect(reused).toMatchObject({ status: 200, replayed: false, body: { amount: 301 } })
    await sql.query(`UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = $1`, [key])
    expect(await running.psp.sweepExpiredKeys()).toBeGreaterThanOrEqual(1)
    const { rows } = await sql.query<{ n: number }>('SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1', [key])
    expect(rows).toEqual([{ n: 0 }])
  })

  it('rejects bad requests without storing them, and checks both keys', async () => {
    const key = randomUUID()
    const bad = await call('POST', '/v1/charges', { key, body: { amount: 1.5, currency: 'EUR', token: 'tok_ok' } })
    expect(bad.status).toBe(400)
    const unknown = await call('POST', '/v1/charges', { key, body: { amount: 100, currency: 'EUR', token: 'tok_ok', card: '4242' } })
    expect(unknown.body).toMatchObject({ error: { message: 'unknown field card' } })
    expect((await call('POST', '/v1/charges', { key, body: { amount: 100, currency: 'EUR', token: 'tok_ok' } })).status).toBe(200)
    expect((await call('POST', '/v1/charges', { body: { amount: 100, currency: 'EUR', token: 'tok_ok' } })).status).toBe(400)
    expect((await call('GET', '/v1/charges/ch_00000000-0000-0000-0000-000000000000')).status).toBe(404)
    expect((await call('GET', '/admin/faults', { auth: 'wrong' })).status).toBe(401)
    expect((await call('GET', '/admin/faults')).status).toBe(401)
    expect((await call('PUT', '/admin/faults', { auth: ADMIN_KEY, body: { decline: 2 } })).status).toBe(400)
  })

  it('answers every body over 16 kB with 413 and stores nothing under its key', async () => {
    const key = randomUUID()
    for (let i = 0; i < 10; i++) {
      expect((await call('POST', '/v1/charges', { key, body: { amount: 100, currency: 'EUR', token: 'tok_ok', note: 'x'.repeat(2_000_000) } })).status).toBe(
        413,
      )
    }
    expect(await call('POST', '/v1/charges', { key, body: { amount: 100, currency: 'EUR', token: 'tok_ok' } })).toMatchObject({ status: 200, replayed: false })
  })

  it('misstates the amount it did when the token or the plan says so', async () => {
    const chargeId = await authorize('tok_wrong_amount_capture', 1500)
    const capture = await call('POST', `/v1/charges/${chargeId}/capture`, { key: randomUUID(), body: {} })
    expect(capture.body).toMatchObject({ status: 'succeeded', amount: 1499, charge: { captured_amount: 1499 } })
    running.faults.plan = { ...NO_FAULTS, wrongAmount: 1 }
    const payout = await call('POST', '/v1/payouts', { key: randomUUID(), body: { amount: 700, currency: 'EUR', destination: 'wash_1' } })
    expect(payout.body).toMatchObject({ kind: 'payout', status: 'succeeded', amount: 699 })
    const refund = await call('POST', `/v1/charges/${chargeId}/refunds`, { key: randomUUID(), body: { amount: 500 } })
    expect(refund.body).toMatchObject({ kind: 'refund', status: 'succeeded', amount: 499, charge: { refunded_amount: 499 } })
  })

  it('rejects a payout when the plan declines it', async () => {
    running.faults.plan = { ...NO_FAULTS, decline: 1 }
    const payout = await call('POST', '/v1/payouts', { key: randomUUID(), body: { amount: 700, currency: 'EUR', destination: 'wash_1' } })
    expect(payout.status).toBe(402)
    expect(payout.body).toMatchObject({ kind: 'payout', status: 'declined', reason: 'payout_rejected', amount: 700 })
  })

  it('sets, shows and drops the weather through the admin endpoint', async () => {
    expect((await call('PUT', '/admin/weather', { body: { label: 'storm', plan: { decline: 1 }, seconds: 60 } })).status).toBe(401)
    expect((await call('PUT', '/admin/weather', { auth: ADMIN_KEY, body: { label: 'storm', plan: { decline: 1 }, seconds: 7200 } })).status).toBe(400)
    const set = await call('PUT', '/admin/weather', { auth: ADMIN_KEY, body: { label: 'storm', plan: { decline: 1 }, seconds: 60 } })
    expect(set).toMatchObject({ status: 200, body: { base: NO_FAULTS, weather: { label: 'storm', plan: { decline: 1 } } } })
    const { weather } = WeatherReply.parse(set.body)
    assert(weather)
    expect(Date.parse(weather.until) - Date.now()).toBeGreaterThan(55_000)
    const declined = await call('POST', '/v1/charges', { key: randomUUID(), body: { amount: 100, currency: 'EUR', token: 'tok_ok' } })
    expect(declined.body).toMatchObject({ status: 'declined' })
    expect((await call('GET', '/admin/weather', { auth: ADMIN_KEY })).body).toMatchObject({ weather: { label: 'storm' } })
    expect((await call('DELETE', '/admin/weather', { auth: ADMIN_KEY })).body).toMatchObject({ weather: null })
    const ok = await call('POST', '/v1/charges', { key: randomUUID(), body: { amount: 100, currency: 'EUR', token: 'tok_ok' } })
    expect(ok.body).toMatchObject({ status: 'succeeded', charge: { status: 'authorized' } })
  })

  it('follows the fault plan set through the admin endpoint', async () => {
    const set = await call('PUT', '/admin/faults', { auth: ADMIN_KEY, body: { seed: 3, decline: 1 } })
    expect(set.body).toMatchObject({ seed: 3, decline: 1, fail: 0 })
    const reply = await call('POST', '/v1/charges', { key: randomUUID(), body: { amount: 100, currency: 'EUR', token: 'tok_ok' } })
    expect(reply.body).toMatchObject({ status: 'declined', reason: 'card_declined' })
  })
})

interface FileLine {
  line: number
  operation: string
  reference: string
  kind: string
  gross: number
  fee: number
  net: number
}

async function settlementFile(day: number): Promise<{ status: number; text: string; head: Record<string, string | undefined>; lines: FileLine[] }> {
  const response = await fetch(`${running.url}/v1/settlements/${day}?currency=EUR`, { headers: { authorization: `Bearer ${API_KEY}` } })
  const text = await response.text()
  if (response.status !== 200) return { status: response.status, text, head: {}, lines: [] }
  const [headNames, headValues, , ...rows] = text.trim().split('\n')
  assert(headNames !== undefined && headValues !== undefined)
  const values = headValues.split(',')
  const head = Object.fromEntries(headNames.split(',').map((name, i) => [name, values[i]]))
  const lines = rows.map((row) => {
    const [line, operation, reference, kind, gross, fee, net] = row.split(',')
    assert(operation !== undefined && reference !== undefined && kind !== undefined)
    return { line: Number(line), operation, reference, kind, gross: Number(gross), fee: Number(fee), net: Number(net) }
  })
  return { status: 200, text, head, lines }
}

describe('settlement files', () => {
  it('settles a closed day once, with the contracted fee, and serves the same file again', async () => {
    const { current_day: today } = Calendar.parse((await call('GET', '/v1/settlements')).body)
    expect((await settlementFile(today)).status).toBe(404)
    const chargeId = await authorize('tok_ok', 2400)
    const captureKey = randomUUID()
    const refundKey = randomUUID()
    expect((await call('POST', `/v1/charges/${chargeId}/capture`, { key: captureKey, body: {} })).status).toBe(200)
    expect((await call('POST', `/v1/charges/${chargeId}/refunds`, { key: refundKey, body: { amount: 400 } })).status).toBe(200)
    expect((await call('PUT', `/admin/settlements/${today}/close`, { auth: ADMIN_KEY })).body).toEqual({ day: today, closed: true })

    const file = await settlementFile(today)
    expect(file.status).toBe(200)
    expect(file.lines.find((l) => l.reference === captureKey)).toMatchObject({ kind: 'capture', gross: 2400, fee: 37, net: 2363 })
    expect(file.lines.find((l) => l.reference === refundKey)).toMatchObject({ kind: 'refund', gross: -400, fee: 0, net: -400 })
    expect(file.lines.map((l) => l.line)).toEqual(file.lines.map((_, i) => i + 1))
    expect(Number(file.head.gross)).toBe(file.lines.reduce((sum, l) => sum + l.gross, 0))
    expect(Number(file.head.net)).toBe(Number(file.head.gross) - Number(file.head.fee))
    expect(file.head).toMatchObject({ file: `stl_EUR_${today}`, day: String(today), lines: String(file.lines.length) })
    expect((await settlementFile(today)).text).toBe(file.text)
  })

  it('puts what happens after an early close into the next file, with the faults of the plan', async () => {
    const { current_day: today } = Calendar.parse((await call('GET', '/v1/settlements')).body)
    running.faults.plan = { ...NO_FAULTS, settlement: { ...NO_FAULTS.settlement, wrongAmount: 1 } }
    const chargeId = await authorize('tok_ok', 1500)
    const key = randomUUID()
    expect((await call('POST', `/v1/charges/${chargeId}/capture`, { key, body: {} })).status).toBe(200)
    await call('PUT', `/admin/settlements/${today}/close`, { auth: ADMIN_KEY })
    expect((await settlementFile(today)).lines.some((l) => l.reference === key)).toBe(false)
    expect((await settlementFile(today + 1)).status).toBe(404)
    await call('PUT', `/admin/settlements/${today + 1}/close`, { auth: ADMIN_KEY })
    expect((await settlementFile(today + 1)).lines.find((l) => l.reference === key)).toMatchObject({ kind: 'capture', gross: 1499, fee: 26, net: 1473 })
  })
})
