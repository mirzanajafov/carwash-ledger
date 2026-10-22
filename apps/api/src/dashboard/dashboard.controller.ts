import { Body, Controller, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common'
import { armFailpoints, disarmFailpoints, type FailpointName } from '@carwash/failpoints'
import { checkAudit, checkLedger, checkPaymentsIncrementally, checkSequenced, readWitness, type WitnessView } from '@carwash/invariants'
import type pg from 'pg'
import { runView, VerificationRuns } from '../audit/verification-runs.ts'
import { AdminOnly, type AuthedRequest } from '../auth/access.guard.ts'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { AuditDatabase } from '../db/audit-database.ts'
import { Database } from '../db/database.ts'
import { ApiError } from '../http/api-error.ts'
import { PlugBody } from '../http/dto.ts'
import { INSTANCE } from '../http/instance.ts'
import { takeTurn } from './limits.ts'

function limited(waitMs: number): ApiError {
  const seconds = Math.ceil(waitMs / 1000)
  return new ApiError(429, 'rate_limited', `this can run again in ${seconds} s`, seconds)
}

@AdminOnly()
@Controller('v1/admin')
export class DashboardController {
  readonly #audit: AuditDatabase
  readonly #db: Database
  readonly #runs: VerificationRuns
  readonly #config: ApiConfig
  readonly #logger = new Logger('dashboard')

  constructor(audit: AuditDatabase, db: Database, runs: VerificationRuns, @Inject(API_CONFIG) config: ApiConfig) {
    this.#audit = audit
    this.#db = db
    this.#runs = runs
    this.#config = config
  }

  async #turn(request: AuthedRequest, name: string, everyMs: number): Promise<void> {
    if (request.client.session) return
    const wait = await takeTurn(this.#db.pool, name, everyMs)
    if (wait !== null) throw limited(wait)
  }

  @Post('plug')
  @HttpCode(202)
  async plug(@Req() request: AuthedRequest, @Body() body: PlugBody) {
    await this.#turn(request, 'plug', this.#config.plugEveryMs)
    armFailpoints(new Map<FailpointName, number>([[body.failpoint, 1]]), (name) => {
      disarmFailpoints()
      this.#logger.warn(`pulling the plug at ${name}`)
      process.kill(process.pid, 'SIGKILL')
    })
    return { object: 'plug', failpoint: body.failpoint, ...INSTANCE, armed_at: new Date().toISOString() }
  }

  @Post('checks')
  @HttpCode(200)
  async checks(@Req() request: AuthedRequest) {
    const pool = this.#pool()
    await this.#turn(request, 'checks', this.#config.checksEveryMs)
    const started = performance.now()
    const witness = await this.#witness()
    const ledger = await checkLedger(pool)
    const payments = await checkPaymentsIncrementally(pool)
    const results = [...ledger, ...payments.results, await checkAudit(pool, witness), await checkSequenced(pool, undefined, { graceSeconds: 10 })]
    return {
      object: 'invariant_checks',
      ran_at: new Date().toISOString(),
      ms: Math.round(performance.now() - started),
      witnessed: witness !== undefined,
      payment_checks: {
        since: payments.since?.takenAt.toISOString() ?? null,
        payments: payments.payments,
        merchant_entries: payments.entries,
      },
      results,
    }
  }

  @Post('verify')
  @HttpCode(202)
  async verify(@Req() request: AuthedRequest) {
    const open = await this.#runs.open()
    if (open) return runView(open)
    await this.#turn(request, 'verify', this.#config.checksEveryMs)
    return runView(await this.#runs.request())
  }

  async #witness(): Promise<WitnessView | undefined> {
    if (!this.#config.witnessUrl) return undefined
    try {
      return await readWitness(this.#config.witnessUrl)
    } catch (error) {
      this.#logger.warn(`the witness could not be read: ${error instanceof Error ? error.message : String(error)}`)
      throw new ApiError(503, 'witness_unavailable', 'the witness could not be read, so try again in a minute', 60)
    }
  }

  #pool(): pg.Pool {
    if (!this.#audit.pool) throw new ApiError(503, 'not_configured', 'AUDIT_DATABASE_URL is not set on this API')
    return this.#audit.pool
  }
}
