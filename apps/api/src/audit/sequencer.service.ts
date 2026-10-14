import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { setTimeout as sleep } from 'node:timers/promises'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { Checkpointer, sequenceBatch, WitnessClient, type CheckpointOutcome } from '@carwash/audit-pg'

@Injectable()
export class Sequencer implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #db: Database
  readonly #config: ApiConfig
  readonly #logger = new Logger('sequencer')
  readonly #stop = new AbortController()
  readonly #checkpointer: Checkpointer | undefined
  #loop: Promise<void> | undefined

  constructor(db: Database, @Inject(API_CONFIG) config: ApiConfig) {
    this.#db = db
    this.#config = config
    if (config.witnessUrl && config.witnessToken) {
      this.#checkpointer = new Checkpointer(db.pool, new WitnessClient(config.witnessUrl, config.witnessToken, config.witnessTimeoutMs))
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
    let failures = 0
    let unreachable = 0
    let sinceCheckpoint = 0
    let checkpointedAt = 0
    while (!this.#stop.signal.aborted) {
      try {
        sinceCheckpoint += await this.drain()
        failures = 0
      } catch (error) {
        failures++
        if (failures === 1 || failures % 50 === 0) this.#logger.warn(`sequencing failed: ${(error as Error).message}`)
      }
      if (this.#checkpointer && (sinceCheckpoint >= this.#config.checkpointEveryLeaves || Date.now() - checkpointedAt >= this.#config.checkpointEveryMs)) {
        checkpointedAt = Date.now()
        try {
          if ((await this.checkpoint())?.kind === 'signed') sinceCheckpoint = 0
          unreachable = 0
        } catch (error) {
          unreachable++
          if (unreachable === 1 || unreachable % 50 === 0) this.#logger.warn(`checkpointing failed: ${(error as Error).message}`)
        }
      }
      await sleep(this.#config.auditEveryMs, undefined, { signal: this.#stop.signal }).catch(() => undefined)
    }
  }
}
