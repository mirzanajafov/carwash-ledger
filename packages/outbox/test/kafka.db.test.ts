import { randomUUID } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureTopics, kafkaClient, KafkaPublisher, laneSql, Relay, type Envelope } from '../src/index.ts'

const BROKERS = (process.env.KAFKA_BROKERS ?? '127.0.0.1:9194').split(',')

let db: TestDatabase
let app: pg.Pool
const topic = `test-${randomUUID()}`
const kafka = kafkaClient({ brokers: BROKERS, clientId: 'outbox-test' })

beforeAll(async () => {
  db = await createTestDatabase()
  app = db.pool('ledger_app', 8)
  expect(await ensureTopics(kafka, [{ topic, partitions: 4, retentionHours: 1 }])).toEqual([topic])
})

afterAll(async () => {
  const admin = kafka.admin()
  await admin.connect()
  await admin.deleteTopics({ topics: [topic] }).catch(() => undefined)
  await admin.disconnect()
  await db?.drop()
})

describe('the relay against Kafka', () => {
  it('delivers every event with its id and type, in order per key', async () => {
    const keys = ['wash-1', 'wash-2', 'wash-3', 'wash-4', 'wash-5', 'wash-6']
    for (let n = 0; n < 20; n++) {
      for (const key of keys) {
        await app.query(`INSERT INTO outbox (topic, key, lane, type, payload) VALUES ($1, $2, ${laneSql('$2')}, 'test.step', $3)`, [
          topic,
          key,
          JSON.stringify({ n }),
        ])
      }
    }
    const publisher = await KafkaPublisher.connect({ brokers: BROKERS, clientId: 'outbox-test', deliveryTimeoutMs: 10_000 })
    const relay = new Relay(app, publisher, { workers: 3, batch: 16, pollMs: 10 })
    relay.start()
    const received: { key: string; envelope: Envelope; headers: Record<string, string> }[] = []
    const consumer = kafka.consumer({ kafkaJS: { groupId: `test-${randomUUID()}`, fromBeginning: true } })
    try {
      await consumer.connect()
      await consumer.subscribe({ topics: [topic] })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`only ${received.length} of ${keys.length * 20} arrived`)), 30_000)
        void consumer.run({
          eachMessage: async ({ message }) => {
            const headers = Object.fromEntries(Object.entries(message.headers ?? {}).map(([name, value]) => [name, String(value)]))
            received.push({ key: message.key!.toString(), envelope: JSON.parse(message.value!.toString()), headers })
            if (received.length === keys.length * 20) {
              clearTimeout(timer)
              resolve()
            }
          },
        })
      })
    } finally {
      await consumer.disconnect()
      await relay.stop()
      await publisher.close()
    }
    for (const key of keys) {
      expect(received.filter((message) => message.key === key).map((message) => (message.envelope.data as { n: number }).n)).toEqual(
        Array.from({ length: 20 }, (_, n) => n),
      )
    }
    const { rows } = await app.query<{ event_id: string }>('SELECT event_id::text FROM outbox WHERE topic = $1 ORDER BY id LIMIT 1', [topic])
    const first = received.find((message) => message.envelope.id === rows[0]!.event_id)!
    expect(first.envelope.type).toBe('test.step')
    expect(first.headers).toEqual({ 'event-id': rows[0]!.event_id, 'event-type': 'test.step' })
    expect(Number.isNaN(Date.parse(first.envelope.occurred_at))).toBe(false)
    expect((await app.query('SELECT 1 FROM outbox WHERE published_at IS NULL')).rowCount).toBe(0)
  })
})
