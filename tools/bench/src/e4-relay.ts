import { createPool } from '@carwash/pg'
import { KafkaPublisher, Relay } from '@carwash/outbox'

const pool = createPool({ connectionString: process.env.E4_DB_URL!, max: 8 })
const publisher = await KafkaPublisher.connect({
  brokers: process.env.E4_BROKERS!.split(','),
  clientId: 'e4-relay',
  deliveryTimeoutMs: 10_000,
  topicPrefix: process.env.E4_PREFIX!,
})
const relay = new Relay(pool, publisher, { workers: 4, batch: 500, pollMs: 50, pauseMs: Number(process.env.E4_PAUSE_MS ?? 10) }, (message) => console.log(`e4-relay: ${message}`))
relay.start()
console.log('e4-relay: ready')

process.once('SIGTERM', async () => {
  await relay.stop()
  await publisher.close()
  await pool.end()
  process.exit(0)
})
