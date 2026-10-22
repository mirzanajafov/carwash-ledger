import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { failpoint } from '@carwash/failpoints'
import { takeSnapshots } from '@carwash/ledger'
import { setTimeout as sleep } from 'node:timers/promises'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { IdempotencyService } from '../idempotency/idempotency.service.ts'
import { AttemptsService } from '../payments/attempts.service.ts'
import type { Attempt } from '../payments/attempt.ts'
import { attemptsToRecover } from '../payments/attempts.repository.ts'
import { PspClient } from '../psp/psp.client.ts'
import { PspAnswerRejectedError, PspUnavailableError } from '../psp/psp.errors.ts'
import { WebhooksService } from '../webhooks/webhooks.service.ts'
import { EventConsumers } from '../consumers/event-consumers.service.ts'
import { Settlements } from '../settlement/settlements.service.ts'
import { OutboxRelay } from './outbox-relay.service.ts'

export type RecoveryOutcome = 'applied' | 'already' | 'anomaly' | 'unknown' | 'error'

@Injectable()
export class Recovery implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #db: Database
  readonly #attempts: AttemptsService
  readonly #psp: PspClient
  readonly #webhooks: WebhooksService
  readonly #idempotency: IdempotencyService
  readonly #outbox: OutboxRelay
  readonly #consumers: EventConsumers
  readonly #settlements: Settlements
  readonly #config: ApiConfig
  readonly #logger = new Logger('recovery')
  readonly #stop = new AbortController()
  readonly #loops: Promise<void>[] = []

  constructor(
    db: Database,
    attempts: AttemptsService,
    psp: PspClient,
    webhooks: WebhooksService,
    idempotency: IdempotencyService,
    outbox: OutboxRelay,
    consumers: EventConsumers,
    settlements: Settlements,
    @Inject(API_CONFIG) config: ApiConfig,
  ) {
    this.#db = db
    this.#attempts = attempts
    this.#psp = psp
    this.#webhooks = webhooks
    this.#idempotency = idempotency
    this.#outbox = outbox
    this.#consumers = consumers
    this.#settlements = settlements
    this.#config = config
  }

  onApplicationBootstrap(): void {
    if (this.#config.recoveryEveryMs === 0) return
    this.#every('pending attempts', this.#config.recoveryEveryMs, () => this.recoverPending())
    this.#every('unmatched webhooks', 30_000, () => this.#webhooks.recheckUnmatched())
    this.#every('sweepers', 60_000, async () => {
      await this.#idempotency.sweep()
      await this.#webhooks.prune()
      await this.#outbox.prune()
      await this.#consumers.prune()
    })
    if (this.#config.settlementEveryMs > 0) this.#every('settlements', this.#config.settlementEveryMs, () => this.#settlements.catchUp())
    if (this.#config.hotAccountMode === 'derived') this.#every('snapshots', 1000, () => takeSnapshots(this.#db.pool))
  }

  async onModuleDestroy(): Promise<void> {
    this.#stop.abort()
    await Promise.all(this.#loops)
  }

  async recoverPending(olderThanSeconds = this.#config.recoveryAfterSeconds, batch = 50): Promise<Map<RecoveryOutcome, number>> {
    const attempts = await attemptsToRecover(this.#db.pool, olderThanSeconds, batch)
    const counts = new Map<RecoveryOutcome, number>()
    for (const attempt of attempts) {
      const outcome = await this.recover(attempt)
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
    }
    if (attempts.length > 0) this.#logger.log(`checked ${attempts.length} pending attempts: ${JSON.stringify(Object.fromEntries(counts))}`)
    return counts
  }

  async recover(attempt: Attempt): Promise<RecoveryOutcome> {
    try {
      const reply = await this.#psp.pull(attempt.id)
      if (reply.kind === 'unknown') return 'unknown'
      if (reply.kind === 'none') return await this.#attempts.settle(attempt)
      failpoint('recovery.after_pull')
      return await this.#attempts.receive(await this.#attempts.callFor(attempt), reply.body)
    } catch (error) {
      if (error instanceof PspUnavailableError) return 'unknown'
      if (error instanceof PspAnswerRejectedError) return 'anomaly'
      this.#logger.error(`attempt ${attempt.id}: ${error instanceof Error ? (error.stack ?? String(error)) : String(error)}`)
      return 'error'
    }
  }

  #every(name: string, intervalMs: number, task: () => Promise<unknown>): void {
    const signal = this.#stop.signal
    this.#loops.push(
      (async () => {
        while (!signal.aborted) {
          try {
            await task()
          } catch (error) {
            this.#logger.error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
          }
          await sleep(intervalMs, undefined, { signal }).catch(() => undefined)
        }
      })(),
    )
  }
}
