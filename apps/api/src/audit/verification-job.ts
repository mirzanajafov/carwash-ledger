import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { setTimeout as sleep } from 'node:timers/promises'
import { verifyLog } from '@carwash/audit-pg'
import { readWitness, type WitnessView } from '@carwash/invariants'
import { inSnapshot } from '@carwash/pg'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { AuditDatabase } from '../db/audit-database.ts'
import { VerificationRuns, type VerificationRun } from './verification-runs.ts'

function messageOf(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

@Injectable()
export class VerificationJob implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #runs: VerificationRuns
  readonly #audit: AuditDatabase
  readonly #config: ApiConfig
  readonly #logger = new Logger('verification')
  readonly #stop = new AbortController()
  #loop: Promise<void> | undefined

  constructor(runs: VerificationRuns, audit: AuditDatabase, @Inject(API_CONFIG) config: ApiConfig) {
    this.#runs = runs
    this.#audit = audit
    this.#config = config
  }

  onApplicationBootstrap(): void {
    if (this.#config.verifyEveryMs === 0 || !this.#audit.pool) return
    this.#loop = this.#run()
  }

  async onModuleDestroy(): Promise<void> {
    this.#stop.abort()
    await this.#loop
  }

  async runNext(): Promise<VerificationRun | undefined> {
    const run = await this.#runs.claim()
    if (!run) return undefined
    const pool = this.#audit.pool
    if (!pool) {
      await this.#runs.fail(run.id, 'this worker has no AUDIT_DATABASE_URL')
      return run
    }
    let witness: WitnessView | undefined
    try {
      witness = this.#config.witnessUrl ? await readWitness(this.#config.witnessUrl) : undefined
    } catch (error) {
      this.#logger.warn(`run ${run.id}: the witness could not be read: ${messageOf(error)}`)
      await this.#runs.fail(run.id, 'the witness could not be read')
      return run
    }
    try {
      const { state, ...report } = await inSnapshot(pool, (client) =>
        verifyLog(client, { witness, onProgress: (done, size) => this.#runs.progress(run.id, done, size) }),
      )
      await this.#runs.finish(run.id, { ...report, root: state?.root ?? null })
      this.#logger.log(`run ${run.id}: ${report.journals} journals, ${report.witnessed} signed roots, ${report.findings} findings in ${report.ms.total} ms`)
    } catch (error) {
      this.#logger.error(`run ${run.id} failed: ${messageOf(error)}`)
      await this.#runs.fail(run.id, 'the verification failed, and the worker logged why')
    }
    return run
  }

  async #run(): Promise<void> {
    let failures = 0
    while (!this.#stop.signal.aborted) {
      try {
        await this.runNext()
        failures = 0
      } catch (error) {
        failures++
        if (failures === 1 || failures % 60 === 0) this.#logger.warn(`claiming a verification run failed: ${messageOf(error)}`)
      }
      await sleep(this.#config.verifyEveryMs, undefined, { signal: this.#stop.signal }).catch(() => undefined)
    }
  }
}
