import { KafkaJS } from '@confluentinc/kafka-javascript'
import type { Envelope } from './events.ts'
import type { OutboxRow, Publisher } from './relay.ts'

export interface TopicSpec {
  topic: string
  partitions: number
  retentionHours: number
}

export const TOPIC_SPECS: readonly TopicSpec[] = [
  { topic: 'payments', partitions: 8, retentionHours: 72 },
  { topic: 'ledger', partitions: 8, retentionHours: 72 },
]

export interface KafkaSettings {
  brokers: string[]
  clientId: string
  deliveryTimeoutMs: number
}

export function kafkaClient(settings: Pick<KafkaSettings, 'brokers' | 'clientId'>): KafkaJS.Kafka {
  return new KafkaJS.Kafka({ kafkaJS: { brokers: settings.brokers, clientId: settings.clientId, logLevel: KafkaJS.logLevel.ERROR } })
}

export async function ensureTopics(kafka: KafkaJS.Kafka, specs: readonly TopicSpec[] = TOPIC_SPECS): Promise<string[]> {
  const admin = kafka.admin()
  await admin.connect()
  try {
    const existing = new Set(await admin.listTopics())
    const missing = specs.filter((spec) => !existing.has(spec.topic))
    if (missing.length > 0) {
      await admin.createTopics({
        topics: missing.map((spec) => ({
          topic: spec.topic,
          numPartitions: spec.partitions,
          replicationFactor: 1,
          configEntries: [{ name: 'retention.ms', value: String(spec.retentionHours * 3_600_000) }],
        })),
      })
    }
    return missing.map((spec) => spec.topic)
  } finally {
    await admin.disconnect()
  }
}

export function envelope(row: OutboxRow): Envelope {
  return { id: row.eventId, type: row.type, occurred_at: row.createdAt.toISOString(), data: row.payload }
}

export class KafkaPublisher implements Publisher {
  readonly #producer: KafkaJS.Producer

  private constructor(producer: KafkaJS.Producer) {
    this.#producer = producer
  }

  static async connect(settings: KafkaSettings): Promise<KafkaPublisher> {
    const producer = kafkaClient(settings).producer({
      kafkaJS: { idempotent: true, acks: -1 },
      'message.timeout.ms': settings.deliveryTimeoutMs,
      'linger.ms': 5,
    })
    await producer.connect()
    return new KafkaPublisher(producer)
  }

  async publish(rows: readonly OutboxRow[]): Promise<void> {
    const byTopic = new Map<string, KafkaJS.Message[]>()
    for (const row of rows) {
      const messages = byTopic.get(row.topic) ?? []
      messages.push({
        key: row.key,
        value: JSON.stringify(envelope(row)),
        headers: { 'event-id': row.eventId, 'event-type': row.type },
      })
      byTopic.set(row.topic, messages)
    }
    await this.#producer.sendBatch({ topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })) })
  }

  async close(): Promise<void> {
    await this.#producer.disconnect()
  }
}
