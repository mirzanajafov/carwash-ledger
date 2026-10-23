import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { PaymentView } from '@carwash/contracts'
import { checkEvents, violations } from '@carwash/invariants'
import { Envelope, kafkaClient } from '@carwash/outbox'
import type { INestApplicationContext } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { EventConsumersService } from '../src/consumers/event-consumers.service.ts'
import { OutboxRelayService } from '../src/worker/outbox-relay.service.ts'
import { WorkerModule } from '../src/worker/worker.module.ts'
import { count, startStack, testConfig, type Stack } from './support.ts'

const BROKERS = (process.env.KAFKA_BROKERS ?? '127.0.0.1:9194').split(',')
const PREFIX = `test-${randomUUID()}.`

let stack: Stack
let worker: INestApplicationContext | undefined

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  stack = await startStack()
  cleanup.defer(() => stack.close())
  cleanup.defer(async () => {
    const admin = kafkaClient({ brokers: BROKERS, clientId: 'api-test' }).admin()
    await admin.connect()
    await admin.deleteTopics({ topics: [`${PREFIX}payments`, `${PREFIX}ledger`] }).catch(() => undefined)
    await admin.disconnect()
  })
})

afterAll(() => cleanup.disposeAsync())

describe('the worker relay', () => {
  it('publishes what the API wrote to the outbox, in order per payment', async () => {
    const payment = PaymentView.parse(
      (await stack.call('POST', '/v1/payments', { body: { amount: 2400, currency: 'EUR', merchant: 'wash_1', token: 'tok_ok' } })).body,
    )
    await stack.call('POST', `/v1/payments/${payment.id}/refunds`, { body: { amount: 2400 } })
    worker = await NestFactory.createApplicationContext(
      WorkerModule.register(testConfig({ ...stack.env, KAFKA_BROKERS: BROKERS.join(','), KAFKA_TOPIC_PREFIX: PREFIX, RELAY_WORKERS: '2' })),
      { logger: false },
    )
    cleanup.defer(() => worker?.close())
    await worker.init()
    const deadline = Date.now() + 30_000
    while ((await count(stack.admin, 'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')) > 0 && Date.now() < deadline) {
      await sleep(100)
    }
    expect(worker.get(OutboxRelayService).running).toBe(true)
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')).toBe(0)

    const consumer = kafkaClient({ brokers: BROKERS, clientId: 'api-test' }).consumer({ kafkaJS: { groupId: `api-test-${randomUUID()}`, fromBeginning: true } })
    const values: string[] = []
    try {
      await consumer.connect()
      await consumer.subscribe({ topics: [`${PREFIX}payments`] })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`saw ${values.length} of 4`)), 30_000)
        void consumer.run({
          eachMessage: async ({ message }) => {
            if (message.key?.toString() !== payment.id) return
            assert(message.value)
            values.push(message.value.toString())
            if (values.length === 4) {
              clearTimeout(timer)
              resolve()
            }
          },
        })
      })
    } finally {
      await consumer.disconnect()
    }
    expect(values.map((value) => Envelope.parse(JSON.parse(value)).type)).toEqual([
      'payment.authorized',
      'payment.captured',
      'refund.succeeded',
      'payment.refunded',
    ])
  })

  it('lets the consumers catch up with everything, so L2 and L3 hold', async () => {
    await stack.call('POST', '/v1/payments', { body: { amount: 900, currency: 'EUR', merchant: 'wash_2', token: 'tok_ok' } })
    await stack.call('POST', '/v1/payouts', { as: 'admin', body: { merchant: 'wash_2', currency: 'EUR' } })
    const deadline = Date.now() + 40_000
    let found = violations(await checkEvents(stack.admin))
    while (found.length > 0 && Date.now() < deadline) {
      await sleep(250)
      found = violations(await checkEvents(stack.admin))
    }
    assert(worker)
    expect(worker.get(EventConsumersService).running).toBe(true)
    expect(found).toEqual([])
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM receipts')).toBe(2)
  })
})
