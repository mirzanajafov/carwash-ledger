import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { linearBackoff, retryLoop } from '@carwash/jobs'
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
    const start = async () => {
      try {
        await this.#startRelay(brokers)
      } catch (error) {
        await this.#publisher?.close().catch(() => undefined)
        this.#publisher = undefined
        throw error
      }
    }
    await retryLoop('cannot reach Kafka yet', start, linearBackoff, { signal: this.#stop.signal, log: (message) => this.#logger.warn(message), logEvery: 30 })
  }

  async #startRelay(brokers: string[]): Promise<void> {
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
  }
}
