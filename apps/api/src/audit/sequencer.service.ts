import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { setTimeout as sleep } from 'node:timers/promises'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { sequenceBatch } from './audit-log.ts'

@Injectable()
export class Sequencer implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #db: Database
  readonly #config: ApiConfig
  readonly #logger = new Logger('sequencer')
  readonly #stop = new AbortController()
  #loop: Promise<void> | undefined

  constructor(db: Database, @Inject(API_CONFIG) config: ApiConfig) {
    this.#db = db
    this.#config = config
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

  async #run(): Promise<void> {
    let failures = 0
    while (!this.#stop.signal.aborted) {
      try {
        await this.drain()
        failures = 0
      } catch (error) {
        failures++
        if (failures === 1 || failures % 50 === 0) this.#logger.warn(`sequencing failed: ${(error as Error).message}`)
      }
      await sleep(this.#config.auditEveryMs, undefined, { signal: this.#stop.signal }).catch(() => undefined)
    }
  }
}
