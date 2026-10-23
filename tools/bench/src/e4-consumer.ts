import { createPool } from '@carwash/pg'
import { EventConsumer, kafkaClient, TOPICS, type ConsumerSpec } from '@carwash/outbox'

const url = process.env.E4_DB_URL
const brokers = process.env.E4_BROKERS
const prefix = process.env.E4_PREFIX
if (!url || !brokers || !prefix) throw new Error('E4_DB_URL, E4_BROKERS and E4_PREFIX are required')
const pool = createPool({ connectionString: url, max: 8 })

const spec: ConsumerSpec = {
  name: 'e4',
  topic: TOPICS.payments,
  apply: async (client, events) => {
    await client.query('INSERT INTO e4_consumed (event_id, consumed_at) SELECT unnest($1::uuid[]), clock_timestamp()', [events.map((event) => event.id)])
  },
}

const consumer = new EventConsumer(
  kafkaClient({ brokers: brokers.split(','), clientId: 'e4-consumer' }),
  pool,
  spec,
  { topicPrefix: prefix, batchSize: 500 },
  (message) => console.log(`e4-consumer: ${message}`),
)
await consumer.start()
console.log('e4-consumer: ready')

async function shutdown(): Promise<void> {
  await consumer.stop()
  await pool.end()
  process.exit(0)
}

process.once('SIGTERM', () => void shutdown())
