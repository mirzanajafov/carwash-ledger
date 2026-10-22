import { setTimeout as sleep } from 'node:timers/promises'
import type { KafkaJS } from '@confluentinc/kafka-javascript'
import { failpoint } from '@carwash/failpoints'
import { withTransaction, type Transaction } from '@carwash/pg'
import type pg from 'pg'
import type { Envelope, Topic } from './events.ts'

export interface ConsumedEvent {
  id: string
  type: string
  key: string
  occurredAt: string
  data: unknown
}

export type ApplyEvents = (client: Transaction, events: readonly ConsumedEvent[]) => Promise<void>

export interface ConsumerSpec {
  name: string
  topic: Topic
  apply: ApplyEvents
}

export type ConsumerLog = (message: string) => void

export async function applyOnce(pool: pg.Pool, spec: ConsumerSpec, events: readonly ConsumedEvent[]): Promise<number> {
  const unique = [...new Map(events.map((event) => [event.id, event])).values()]
  if (unique.length === 0) return 0
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ event_id: string }>(
      `INSERT INTO inbox (consumer, event_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING RETURNING event_id::text`,
      [spec.name, unique.map((event) => event.id)],
    )
    const fresh = new Set(rows.map((row) => row.event_id))
    const apply = unique.filter((event) => fresh.has(event.id))
    if (apply.length > 0) await spec.apply(client, apply)
    failpoint('consumer.before_commit')
    return apply.length
  })
}

export function parseMessage(key: Buffer | null, value: Buffer | null): ConsumedEvent | undefined {
  if (!value) return undefined
  try {
    const envelope = JSON.parse(value.toString()) as Envelope
    if (typeof envelope.id !== 'string' || typeof envelope.type !== 'string') return undefined
    return { id: envelope.id, type: envelope.type, key: key?.toString() ?? '', occurredAt: envelope.occurred_at, data: envelope.data }
  } catch {
    return undefined
  }
}

export interface ConsumerSettings {
  topicPrefix: string
  batchSize: number
}

export class EventConsumer {
  readonly #kafka: KafkaJS.Kafka
  readonly #pool: pg.Pool
  readonly #spec: ConsumerSpec
  readonly #settings: ConsumerSettings
  readonly #log: ConsumerLog
  readonly #stop = new AbortController()
  #consumer: KafkaJS.Consumer | undefined
  applied = 0
  seen = 0

  constructor(kafka: KafkaJS.Kafka, pool: pg.Pool, spec: ConsumerSpec, settings: ConsumerSettings, log: ConsumerLog = () => undefined) {
    this.#kafka = kafka
    this.#pool = pool
    this.#spec = spec
    this.#settings = settings
    this.#log = log
  }

  async start(): Promise<void> {
    const consumer = this.#kafka.consumer({
      kafkaJS: {
        groupId: `${this.#settings.topicPrefix}${this.#spec.name}`,
        fromBeginning: true,
        autoCommit: false,
        sessionTimeout: 6000,
        heartbeatInterval: 1000,
      },
      'js.consumer.max.batch.size': this.#settings.batchSize,
      'topic.metadata.refresh.interval.ms': 10_000,
    })
    this.#consumer = consumer
    await consumer.connect()
    await consumer.subscribe({ topics: [`${this.#settings.topicPrefix}${this.#spec.topic}`] })
    void consumer.run({
      eachBatch: async ({ batch }) => {
        const events = batch.messages.map((message) => parseMessage(message.key, message.value)).filter((event) => event !== undefined)
        await this.#applyUntilDone(events)
        this.seen += batch.messages.length
        failpoint('consumer.before_offset')
        await consumer.commitOffsets([{ topic: batch.topic, partition: batch.partition, offset: (BigInt(batch.lastOffset()) + 1n).toString() }])
      },
    })
  }

  async stop(): Promise<void> {
    this.#stop.abort()
    await this.#consumer?.disconnect()
  }

  async #applyUntilDone(events: readonly ConsumedEvent[]): Promise<void> {
    for (let failures = 0; ; failures++) {
      try {
        this.applied += await applyOnce(this.#pool, this.#spec, events)
        return
      } catch (error) {
        if (this.#stop.signal.aborted) throw error
        if (failures === 0 || failures % 50 === 0) this.#log(`${this.#spec.name}: ${error instanceof Error ? error.message : String(error)}`)
        await sleep(Math.min(2000, 50 * 2 ** Math.min(failures, 6)), undefined, { signal: this.#stop.signal }).catch(() => undefined)
      }
    }
  }
}
