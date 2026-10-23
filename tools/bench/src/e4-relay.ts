import { nonNegativeInteger, required } from '@carwash/env'
import { createPool } from '@carwash/pg'
import { KafkaPublisher, Relay } from '@carwash/outbox'

const url = required(process.env, 'E4_DB_URL')
const brokers = required(process.env, 'E4_BROKERS').split(',')
const prefix = required(process.env, 'E4_PREFIX')
const pool = createPool({ connectionString: url, max: 8 })
const publisher = await KafkaPublisher.connect({
  brokers,
  clientId: 'e4-relay',
  deliveryTimeoutMs: 10_000,
  topicPrefix: prefix,
})
const relay = new Relay(pool, publisher, { workers: 4, batch: 500, pollMs: 50, pauseMs: nonNegativeInteger(process.env, 'E4_PAUSE_MS', 10) }, (message) =>
  console.log(`e4-relay: ${message}`),
)
relay.start()
console.log('e4-relay: ready')

async function shutdown(): Promise<void> {
  await relay.stop()
  await publisher.close()
  await pool.end()
  process.exit(0)
}

process.once('SIGTERM', () => void shutdown())
