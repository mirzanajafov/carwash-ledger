import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { setTimeout as sleep } from 'node:timers/promises'
import { ensureTopics, kafkaClient, KafkaPublisher, Relay, topicSpecs } from '@carwash/outbox'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #db: Database
  readonly #config: ApiConfig
  readonly #logger = new Logger('relay')
  #relay: Relay | undefined
  #publisher: KafkaPublisher | undefined
  #starting: Promise<void> | undefined
  readonly #stop = new AbortController()

  constructor(db: Database, @Inject(API_CONFIG) config: ApiConfig) {
    this.#db = db
    this.#config = config
  }

  onApplicationBootstrap(): void {
    const brokers = [...this.#config.kafkaBrokers]
    if (brokers.length === 0) {
      this.#logger.warn('KAFKA_BROKERS is not set, so events stay in the outbox')
      return
    }
    this.#starting = this.#start(brokers)
  }

  async onModuleDestroy(): Promise<void> {
    this.#stop.abort()
    await this.#starting
    await this.#relay?.stop()
    await this.#publisher?.close()
  }

  get running(): boolean {
    return this.#relay !== undefined
  }

  async #start(brokers: string[]): Promise<void> {
    for (let attempt = 1; !this.#stop.signal.aborted; attempt++) {
      try {
        const created = await ensureTopics(kafkaClient({ brokers, clientId: 'carwash-worker' }), topicSpecs(this.#config.kafkaTopicPrefix))
        if (created.length > 0) this.#logger.log(`created topics ${created.join(', ')}`)
        this.#publisher = await KafkaPublisher.connect({
          brokers,
          clientId: 'carwash-relay',
          deliveryTimeoutMs: 10_000,
          topicPrefix: this.#config.kafkaTopicPrefix,
        })
        if (this.#stop.signal.aborted) return
        this.#relay = new Relay(this.#db.pool, this.#publisher, { workers: this.#config.relayWorkers, idleMaxMs: this.#config.relayIdleMaxMs }, (message) =>
          this.#logger.warn(message),
        )
        this.#relay.start()
        return
      } catch (error) {
        await this.#publisher?.close().catch(() => undefined)
        this.#publisher = undefined
        if (attempt === 1 || attempt % 30 === 0) this.#logger.warn(`cannot reach Kafka yet: ${(error as Error).message}`)
        await sleep(Math.min(5000, 250 * attempt), undefined, { signal: this.#stop.signal }).catch(() => undefined)
      }
    }
  }

  async prune(batch = 5000): Promise<number> {
    let deleted = 0
    for (;;) {
      const result = await this.#db.pool.query(
        `DELETE FROM outbox WHERE id IN (
           SELECT id FROM outbox WHERE published_at < now() - make_interval(hours => $1) ORDER BY id LIMIT $2)`,
        [this.#config.outboxRetentionHours, batch],
      )
      deleted += result.rowCount ?? 0
      if ((result.rowCount ?? 0) < batch) return deleted
    }
  }
}
