import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { runEvery } from '@carwash/jobs'
import { takeSnapshots } from '@carwash/ledger'
import { pruneInbox, pruneOutbox } from '@carwash/outbox'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { IdempotencyService } from '../idempotency/idempotency.service.ts'
import { Settlements } from '../settlement/settlements.service.ts'
import { WebhooksService } from '../webhooks/webhooks.service.ts'
import { Recovery } from './recovery.service.ts'

@Injectable()
export class Scheduler implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #db: Database
  readonly #recovery: Recovery
  readonly #webhooks: WebhooksService
  readonly #idempotency: IdempotencyService
  readonly #settlements: Settlements
  readonly #config: ApiConfig
  readonly #logger = new Logger('scheduler')
  readonly #stop = new AbortController()
  readonly #loops: Promise<void>[] = []

  constructor(
    db: Database,
    recovery: Recovery,
    webhooks: WebhooksService,
    idempotency: IdempotencyService,
    settlements: Settlements,
    @Inject(API_CONFIG) config: ApiConfig,
  ) {
    this.#db = db
    this.#recovery = recovery
    this.#webhooks = webhooks
    this.#idempotency = idempotency
    this.#settlements = settlements
    this.#config = config
  }

  onApplicationBootstrap(): void {
    const config = this.#config
    if (config.recoveryEveryMs === 0) return
    this.#every('pending attempts', config.recoveryEveryMs, () => this.#recovery.recoverPending())
    this.#every('unmatched webhooks', 30_000, () => this.#webhooks.recheckUnmatched())
    this.#every('sweepers', 60_000, async () => {
      await this.#idempotency.sweep()
      await this.#webhooks.prune()
      await pruneOutbox(this.#db.pool, config.outboxRetentionHours)
      await pruneInbox(this.#db.pool, config.inboxRetentionDays)
    })
    if (config.settlementEveryMs > 0) this.#every('settlements', config.settlementEveryMs, () => this.#settlements.catchUp())
    if (config.hotAccountMode === 'derived') this.#every('snapshots', 1000, () => takeSnapshots(this.#db.pool))
  }

  async onModuleDestroy(): Promise<void> {
    this.#stop.abort()
    await Promise.all(this.#loops)
  }

  #every(label: string, intervalMs: number, task: () => Promise<unknown>): void {
    this.#loops.push(runEvery(label, intervalMs, task, { signal: this.#stop.signal, log: (message) => this.#logger.error(message) }))
  }
}
