import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { checkEvents, violations } from '@carwash/invariants'
import { kafkaClient, type Envelope } from '@carwash/outbox'
import { NestFactory } from '@nestjs/core'
import type { INestApplicationContext } from '@nestjs/common'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { EventConsumers } from '../src/consumers/event-consumers.service.ts'
import { OutboxRelay } from '../src/worker/outbox-relay.service.ts'
import { WorkerModule } from '../src/worker/worker.module.ts'
import { count, startStack, type Stack } from './support.ts'

const BROKERS = (process.env.KAFKA_BROKERS ?? '127.0.0.1:9194').split(',')
const PREFIX = `test-${randomUUID()}.`

let stack: Stack
let worker: INestApplicationContext | undefined

beforeAll(async () => {
  stack = await startStack()
})

afterAll(async () => {
  await worker?.close()
  const admin = kafkaClient({ brokers: BROKERS, clientId: 'api-test' }).admin()
  await admin.connect()
  await admin.deleteTopics({ topics: [`${PREFIX}payments`, `${PREFIX}ledger`] }).catch(() => undefined)
  await admin.disconnect()
  await stack.close()
})

describe('the worker relay', () => {
  it('publishes what the API wrote to the outbox, in order per payment', async () => {
    const payment = (await stack.call('POST', '/v1/payments', { body: { amount: 2400, currency: 'EUR', merchant: 'wash_1', token: 'tok_ok' } })).body
    await stack.call('POST', `/v1/payments/${payment.id}/refunds`, { body: { amount: 2400 } })
    worker = await NestFactory.createApplicationContext(
      WorkerModule.register({ ...stack.config, recoveryEveryMs: 0, kafkaBrokers: BROKERS, kafkaTopicPrefix: PREFIX, relayWorkers: 2 }),
      { logger: false },
    )
    await worker.init()
    const deadline = Date.now() + 30_000
    while ((await count(stack.admin, 'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')) > 0 && Date.now() < deadline) {
      await sleep(100)
    }
    expect(worker.get(OutboxRelay).running).toBe(true)
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')).toBe(0)

    const consumer = kafkaClient({ brokers: BROKERS, clientId: 'api-test' }).consumer({ kafkaJS: { groupId: `api-test-${randomUUID()}`, fromBeginning: true } })
    const types: string[] = []
    try {
      await consumer.connect()
      await consumer.subscribe({ topics: [`${PREFIX}payments`] })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`saw ${types.join(', ')}`)), 30_000)
        void consumer.run({
          eachMessage: async ({ message }) => {
            if (message.key?.toString() !== payment.id) return
            assert(message.value)
            types.push((JSON.parse(message.value.toString()) as Envelope).type)
            if (types.length === 4) {
              clearTimeout(timer)
              resolve()
            }
          },
        })
      })
    } finally {
      await consumer.disconnect()
    }
    expect(types).toEqual(['payment.authorized', 'payment.captured', 'refund.succeeded', 'payment.refunded'])
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
    expect(worker.get(EventConsumers).running).toBe(true)
    expect(found).toEqual([])
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM receipts')).toBe(2)
  })
})
