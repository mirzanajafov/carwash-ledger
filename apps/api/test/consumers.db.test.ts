import { EntryPostedData, PaymentEventData, RefundEventData } from '@carwash/contracts'
import { checkEvents, checkLedger, violations } from '@carwash/invariants'
import fc from 'fast-check'
import type pg from 'pg'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { Database } from '../src/db/database.ts'
import { deliver, outboxEvents, startStack, type OutboxEvent, type Stack } from './support.ts'

let stack: Stack
let app: pg.Pool
const captured: Record<'wash_1' | 'wash_2', string[]> = { wash_1: [], wash_2: [] }

function pay(merchant: string, extra: Record<string, unknown> = {}) {
  return { amount: 1500, currency: 'EUR', merchant, token: 'tok_ok', ...extra }
}

async function receipts(): Promise<{ merchant: string; number: number; payment_id: string; amount: string }[]> {
  const { rows } = await stack.admin.query('SELECT merchant, number, payment_id::text, amount::text FROM receipts ORDER BY merchant, number')
  return rows
}

async function forgetEverythingConsumed(): Promise<void> {
  await stack.admin.query('DELETE FROM inbox; DELETE FROM receipts; DELETE FROM receipt_counters; DELETE FROM statements')
}

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  stack = await startStack()
  cleanup.defer(() => stack.close())
  app = stack.app.get(Database).pool
  const call = stack.call
  for (const merchant of ['wash_1', 'wash_2', 'wash_1'] as const) {
    captured[merchant].push((await call('POST', '/v1/payments', { body: pay(merchant) })).body.id)
  }
  const manual = (await call('POST', '/v1/payments', { body: pay('wash_1', { capture: 'manual' }) })).body.id
  await call('POST', `/v1/payments/${manual}/capture`, { body: { amount: 900 } })
  captured.wash_1.push(manual)
  await call('POST', `/v1/payments/${manual}/refunds`, { body: { amount: 400 } })
  await call('POST', `/v1/payments/${captured.wash_2[0]}/refunds`, { body: { amount: 1500 } })
  const canceled = (await call('POST', '/v1/payments', { body: pay('wash_2', { capture: 'manual' }) })).body.id
  await call('POST', `/v1/payments/${canceled}/cancel`)
  await call('POST', '/v1/payments', { body: pay('wash_2', { token: 'tok_decline' }) })
  await call('POST', '/v1/payouts', { as: 'admin', body: { merchant: 'wash_1', currency: 'EUR' } })
})

afterAll(() => cleanup.disposeAsync())

describe('the consumers', () => {
  it('issue one receipt per capture, numbered per merchant from 1, and keep statements equal to the ledger', async () => {
    await deliver(app, [await outboxEvents(app)])
    const issued = await receipts()
    expect(issued.map((r) => [r.merchant, r.number])).toEqual([
      ['wash_1', 1],
      ['wash_1', 2],
      ['wash_1', 3],
      ['wash_2', 1],
    ])
    expect(issued.filter((r) => r.merchant === 'wash_1').map((r) => r.payment_id)).toEqual(captured.wash_1)
    expect(issued.find((r) => r.payment_id === captured.wash_1[2])).toMatchObject({ amount: '900' })
    expect(violations(await checkEvents(stack.admin))).toEqual([])
    expect(violations(await checkLedger(stack.admin))).toEqual([])
  })

  it('receive payloads that match the schemas the outbox publishes', async () => {
    const events = await outboxEvents(app, 'all')
    const families = { payment: PaymentEventData, refund: RefundEventData, entry: EntryPostedData }
    for (const event of events) {
      const family = event.type.split('.')[0]
      assert(family === 'payment' || family === 'refund' || family === 'entry', `no schema for ${event.type}`)
      families[family].parse(event.data)
    }
    expect([...new Set(events.map((event) => event.type))]).toEqual(
      expect.arrayContaining(['payment.authorized', 'payment.captured', 'payment.canceled', 'payment.failed', 'refund.succeeded', 'entry.posted']),
    )
  })

  it('do each event once, whatever the order, the batches and the redeliveries', async () => {
    const events = await outboxEvents(app, 'all')
    expect(events.length).toBeGreaterThan(30)
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(events, { minLength: events.length, maxLength: events.length }),
        fc.array(fc.constantFrom(...events), { maxLength: events.length }),
        fc.integer({ min: 1, max: 12 }),
        async (order, again, size) => {
          await forgetEverythingConsumed()
          const arrivals: OutboxEvent[] = [...order, ...again]
          const batches = Array.from({ length: Math.ceil(arrivals.length / size) }, (_, i) => arrivals.slice(i * size, (i + 1) * size))
          await deliver(app, batches)
          expect(violations(await checkEvents(stack.admin))).toEqual([])
          expect((await receipts()).length).toBe(4)
        },
      ),
      { numRuns: 12 },
    )
  })
})
