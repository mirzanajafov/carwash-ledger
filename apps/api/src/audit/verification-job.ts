import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { verifyLog } from '@carwash/audit-pg'
import { readWitness, type WitnessView } from '@carwash/invariants'
import { runEvery } from '@carwash/jobs'
import { inSnapshot } from '@carwash/pg'
import type pg from 'pg'
import { CORE_CONFIG, WORKER_CONFIG, type CoreConfig, type WorkerConfig } from '../config.ts'
import { AuditDatabase } from '../db/audit-database.ts'
import { VerificationRuns, type VerificationRun } from './verification-runs.ts'

@Injectable()
export class VerificationJob implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #runs: VerificationRuns
  readonly #pool: pg.Pool
  readonly #config: WorkerConfig
  readonly #witnessUrl: string | undefined
  readonly #logger = new Logger('verification')
  readonly #stop = new AbortController()
  #loop: Promise<void> | undefined

  constructor(runs: VerificationRuns, audit: AuditDatabase, @Inject(WORKER_CONFIG) config: WorkerConfig, @Inject(CORE_CONFIG) core: CoreConfig) {
    if (!audit.pool) throw new Error('AUDIT_DATABASE_URL is required in the worker')
    this.#runs = runs
    this.#pool = audit.pool
    this.#config = config
    this.#witnessUrl = core.witnessUrl
  }

  onApplicationBootstrap(): void {
    if (this.#config.verifyEveryMs === 0) return
    this.#loop = runEvery('a verification run could not be claimed or closed', this.#config.verifyEveryMs, () => this.runNext(), {
      signal: this.#stop.signal,
      log: (message) => this.#logger.warn(message),
      logEvery: 60,
    })
  }

  async onModuleDestroy(): Promise<void> {
    this.#stop.abort()
    await this.#loop
  }

  async runNext(): Promise<VerificationRun | undefined> {
    const run = await this.#runs.claim()
    if (!run) return undefined
    let witness: WitnessView | undefined
    try {
      witness = this.#witnessUrl ? await readWitness(this.#witnessUrl) : undefined
    } catch (error) {
      this.#logger.warn(`run ${run.id}: the witness could not be read: ${error instanceof Error ? error.message : String(error)}`)
      await this.#runs.retryOrFail(run, 'the witness could not be read')
      return run
    }
    const onProgress = async (checked: number, size: number) => {
      if (!(await this.#runs.progress(run, checked, size))) throw new Error(`run ${run.id} was taken over by another worker`)
    }
    try {
      const { state, ...report } = await inSnapshot(this.#pool, (client) => verifyLog(client, { witness, signal: this.#stop.signal, onProgress }))
      if (await this.#runs.finish(run, { ...report, root: state?.root ?? null }))
        this.#logger.log(`run ${run.id}: ${report.journals} journals, ${report.witnessed} signed roots, ${report.findings} findings in ${report.ms.total} ms`)
      else this.#logger.warn(`run ${run.id} was taken over by another worker before it finished`)
    } catch (error) {
      if (this.#stop.signal.aborted) {
        this.#logger.log(`run ${run.id} stopped with the worker, and the next worker starts it again once its lease ends`)
      } else {
        this.#logger.error(`run ${run.id} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
        await this.#runs.retryOrFail(run, 'the verification failed, and the worker logged why')
      }
    }
    return run
  }
}
