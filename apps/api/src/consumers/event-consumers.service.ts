import { setTimeout as sleep } from 'node:timers/promises'
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { EventConsumer, ensureTopics, kafkaClient, topicSpecs } from '@carwash/outbox'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { receipts } from './receipts.ts'
import { statements } from './statements.ts'

export const CONSUMERS = [receipts, statements]

@Injectable()
export class EventConsumers implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #db: Database
  readonly #config: ApiConfig
  readonly #logger = new Logger('consumers')
  readonly #stop = new AbortController()
  readonly #consumers: EventConsumer[] = []
  #starting: Promise<void> | undefined

  constructor(db: Database, @Inject(API_CONFIG) config: ApiConfig) {
    this.#db = db
    this.#config = config
  }

  get running(): boolean {
    return this.#consumers.length === CONSUMERS.length
  }

  onApplicationBootstrap(): void {
    if (this.#config.kafkaBrokers.length === 0) return
    this.#starting = this.#start()
  }

  async onModuleDestroy(): Promise<void> {
    this.#stop.abort()
    await this.#starting
    await Promise.all(this.#consumers.map((consumer) => consumer.stop().catch(() => undefined)))
  }

  async prune(batch = 5000): Promise<number> {
    let deleted = 0
    for (;;) {
      const result = await this.#db.pool.query(
        `DELETE FROM inbox WHERE ctid IN (
           SELECT ctid FROM inbox WHERE received_at < now() - make_interval(days => $1) LIMIT $2)`,
        [this.#config.inboxRetentionDays, batch],
      )
      deleted += result.rowCount ?? 0
      if ((result.rowCount ?? 0) < batch) return deleted
    }
  }

  async #start(): Promise<void> {
    const brokers = [...this.#config.kafkaBrokers]
    const prefix = this.#config.kafkaTopicPrefix
    const kafka = kafkaClient({ brokers, clientId: 'carwash-consumers' })
    for (let attempt = 1; !this.#stop.signal.aborted; attempt++) {
      try {
        await this.#startConsumers(kafka, prefix)
        return
      } catch (error) {
        if (attempt === 1 || attempt % 30 === 0) this.#logger.warn(`cannot start the consumers yet: ${error instanceof Error ? error.message : String(error)}`)
        await sleep(Math.min(5000, 250 * attempt), undefined, { signal: this.#stop.signal }).catch(() => undefined)
      }
    }
  }

  async #startConsumers(kafka: ReturnType<typeof kafkaClient>, prefix: string): Promise<void> {
    await ensureTopics(kafka, topicSpecs(prefix))
    for (const spec of CONSUMERS.slice(this.#consumers.length)) {
      if (this.#stop.signal.aborted) return
      const consumer = new EventConsumer(kafka, this.#db.pool, spec, { topicPrefix: prefix, batchSize: 200 }, (message) => this.#logger.warn(message))
      await consumer.start()
      this.#consumers.push(consumer)
    }
  }
}
