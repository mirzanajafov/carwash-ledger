import { createPool } from '@carwash/pg'
import { KafkaPublisher, Relay } from '@carwash/outbox'

const url = process.env.E4_DB_URL
const brokers = process.env.E4_BROKERS
const prefix = process.env.E4_PREFIX
if (!url || !brokers || !prefix) throw new Error('E4_DB_URL, E4_BROKERS and E4_PREFIX are required')
const pool = createPool({ connectionString: url, max: 8 })
const publisher = await KafkaPublisher.connect({
  brokers: brokers.split(','),
  clientId: 'e4-relay',
  deliveryTimeoutMs: 10_000,
  topicPrefix: prefix,
})
const relay = new Relay(pool, publisher, { workers: 4, batch: 500, pollMs: 50, pauseMs: Number(process.env.E4_PAUSE_MS ?? 10) }, (message) =>
  console.log(`e4-relay: ${message}`),
)
relay.start()
console.log('e4-relay: ready')

process.once('SIGTERM', async () => {
  await relay.stop()
  await publisher.close()
  await pool.end()
  process.exit(0)
})
