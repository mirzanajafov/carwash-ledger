import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { Checkpointer, sequenceBatch, WitnessClient, type CheckpointOutcome } from '@carwash/audit-pg'
import { Failures, pause } from '@carwash/jobs'
import { CORE_CONFIG, WORKER_CONFIG, type CoreConfig, type WorkerConfig } from '../config.ts'
import { Database } from '../db/database.ts'

@Injectable()
export class SequencerService implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #db: Database
  readonly #config: WorkerConfig
  readonly #logger = new Logger('sequencer')
  readonly #stop = new AbortController()
  readonly #checkpointer: Checkpointer | undefined
  #loop: Promise<void> | undefined

  constructor(db: Database, @Inject(WORKER_CONFIG) config: WorkerConfig, @Inject(CORE_CONFIG) core: CoreConfig) {
    this.#db = db
    this.#config = config
    if (core.witnessUrl && config.witnessToken) {
      this.#checkpointer = new Checkpointer(db.pool, new WitnessClient(core.witnessUrl, config.witnessToken, config.witnessTimeoutMs))
    }
  }

  onApplicationBootstrap(): void {
    if (this.#config.auditEveryMs === 0) return
    this.#loop = this.#run()
  }

  async onModuleDestroy(): Promise<void> {
    this.#stop.abort()
    await this.#loop
  }

  async drain(): Promise<number> {
    let total = 0
    for (;;) {
      const sequenced = await this.#db.transaction((client) => sequenceBatch(client, this.#config.auditBatch))
      total += sequenced
      if (sequenced < this.#config.auditBatch) return total
    }
  }

  async checkpoint(): Promise<CheckpointOutcome | undefined> {
    if (!this.#checkpointer) return undefined
    const outcome = await this.#checkpointer.run()
    if (outcome.kind === 'refused') {
      this.#logger.error(`the witness refused size ${outcome.size} (${outcome.code}): ${outcome.message}`)
    } else if (outcome.kind === 'behind') {
      this.#logger.error(`the log has ${outcome.size} leaves but the witness has signed ${outcome.witnessed}`)
    }
    return outcome
  }

  async #run(): Promise<void> {
    const warn = (message: string) => this.#logger.warn(message)
    const sequencing = new Failures('sequencing failed', warn, 50)
    const checkpointing = new Failures('checkpointing failed', warn, 50)
    let sinceCheckpoint = 0
    let checkpointedAt = 0
    while (!this.#stop.signal.aborted) {
      try {
        sinceCheckpoint += await this.drain()
        sequencing.clear()
      } catch (error) {
        sequencing.record(error)
      }
      if (this.#checkpointer && (sinceCheckpoint >= this.#config.checkpointEveryLeaves || Date.now() - checkpointedAt >= this.#config.checkpointEveryMs)) {
        checkpointedAt = Date.now()
        try {
          if ((await this.checkpoint())?.kind === 'signed') sinceCheckpoint = 0
          checkpointing.clear()
        } catch (error) {
          checkpointing.record(error)
        }
      }
      await pause(this.#config.auditEveryMs, this.#stop.signal)
    }
  }
}
