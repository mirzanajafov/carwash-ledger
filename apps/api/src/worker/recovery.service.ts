import { Inject, Injectable, Logger } from '@nestjs/common'
import { failpoint } from '@carwash/failpoints'
import { WORKER_CONFIG, type WorkerConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { AttemptsService } from '../payments/attempts.service.ts'
import type { Attempt } from '../payments/attempt.ts'
import { attemptsToRecover } from '../payments/attempts.repository.ts'
import { PspClient } from '../psp/psp.client.ts'
import { PspAnswerRejectedError, PspUnavailableError } from '../psp/psp.errors.ts'

export type RecoveryOutcome = 'applied' | 'already' | 'anomaly' | 'unknown' | 'error'

@Injectable()
export class RecoveryService {
  readonly #db: Database
  readonly #attempts: AttemptsService
  readonly #psp: PspClient
  readonly #config: WorkerConfig
  readonly #logger = new Logger('recovery')

  constructor(db: Database, attempts: AttemptsService, psp: PspClient, @Inject(WORKER_CONFIG) config: WorkerConfig) {
    this.#db = db
    this.#attempts = attempts
    this.#psp = psp
    this.#config = config
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
}
