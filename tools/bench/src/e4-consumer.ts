import { createPool } from '@carwash/pg'
import { EventConsumer, kafkaClient, TOPICS, type ConsumerSpec } from '@carwash/outbox'

const pool = createPool({ connectionString: process.env.E4_DB_URL!, max: 8 })

const spec: ConsumerSpec = {
  name: 'e4',
  topic: TOPICS.payments,
  apply: async (client, events) => {
    await client.query('INSERT INTO e4_consumed (event_id, consumed_at) SELECT unnest($1::uuid[]), clock_timestamp()', [events.map((event) => event.id)])
  },
}

const consumer = new EventConsumer(
  kafkaClient({ brokers: process.env.E4_BROKERS!.split(','), clientId: 'e4-consumer' }),
  pool,
  spec,
  { topicPrefix: process.env.E4_PREFIX!, batchSize: 500 },
  (message) => console.log(`e4-consumer: ${message}`),
)
await consumer.start()
console.log('e4-consumer: ready')

process.once('SIGTERM', async () => {
  await consumer.stop()
  await pool.end()
  process.exit(0)
})
