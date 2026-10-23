import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { linearBackoff, retryUntilStopped } from '@carwash/jobs'
import { EventConsumer, ensureTopics, kafkaClient, topicSpecs } from '@carwash/outbox'
import { WORKER_CONFIG, type WorkerConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { receipts } from './receipts.ts'
import { statements } from './statements.ts'

export const CONSUMERS = [receipts, statements]

@Injectable()
export class EventConsumers implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #db: Database
  readonly #config: WorkerConfig
  readonly #logger = new Logger('consumers')
  readonly #stop = new AbortController()
  readonly #consumers: EventConsumer[] = []
  #starting: Promise<void> | undefined

  constructor(db: Database, @Inject(WORKER_CONFIG) config: WorkerConfig) {
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

  async #start(): Promise<void> {
    const brokers = [...this.#config.kafkaBrokers]
    const prefix = this.#config.kafkaTopicPrefix
    const kafka = kafkaClient({ brokers, clientId: 'carwash-consumers' })
    await retryUntilStopped('cannot start the consumers yet', linearBackoff, () => this.#startConsumers(kafka, prefix), {
      signal: this.#stop.signal,
      log: (message) => this.#logger.warn(message),
      logEvery: 30,
    })
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
