import { Body, Controller, HttpCode, Inject, Injectable, Logger, Post, Req, type OnModuleDestroy } from '@nestjs/common'
import { verifyLog } from '@carwash/audit-pg'
import { armFailpoints, disarmFailpoints, type FailpointName } from '@carwash/failpoints'
import { checkAudit, checkLedger, checkPayments, checkSequenced, readWitness, type WitnessView } from '@carwash/invariants'
import { createPool, inSnapshot } from '@carwash/pg'
import { IsIn } from 'class-validator'
import type pg from 'pg'
import { AdminOnly, type AuthedRequest } from '../auth/access.guard.ts'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { ApiError } from '../http/api-error.ts'
import { INSTANCE } from '../http/instance.ts'
import { takeTurn } from './limits.ts'

export const PLUGS = ['post.after_lock', 'attempt.after_psp', 'transaction.before_commit', 'transaction.after_commit', 'request.before_finish'] as const

export class PlugBody {
  @IsIn(PLUGS)
  failpoint!: (typeof PLUGS)[number]
}

@Injectable()
export class AuditDatabase implements OnModuleDestroy {
  readonly pool: pg.Pool | undefined

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.pool = config.auditDatabaseUrl ? createPool({ connectionString: config.auditDatabaseUrl, max: 2, connectionTimeoutMillis: 5000 }) : undefined
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end()
  }
}

function limited(waitMs: number): ApiError {
  const seconds = Math.ceil(waitMs / 1000)
  return new ApiError(429, 'rate_limited', `this can run again in ${seconds} s`, { 'retry-after': String(seconds) })
}

@AdminOnly()
@Controller('v1/admin')
export class DashboardController {
  readonly #audit: AuditDatabase
  readonly #db: Database
  readonly #config: ApiConfig
  readonly #logger = new Logger('dashboard')

  constructor(audit: AuditDatabase, db: Database, @Inject(API_CONFIG) config: ApiConfig) {
    this.#audit = audit
    this.#db = db
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
    const results = [
      ...(await checkLedger(pool)),
      ...(await checkPayments(pool)),
      await checkAudit(pool, witness),
      await checkSequenced(pool, undefined, { graceSeconds: 10 }),
    ]
    return {
      object: 'invariant_checks',
      ran_at: new Date().toISOString(),
      ms: Math.round(performance.now() - started),
      witnessed: witness !== undefined,
      results,
    }
  }

  @Post('verify')
  @HttpCode(200)
  async verify(@Req() request: AuthedRequest) {
    const pool = this.#pool()
    await this.#turn(request, 'verify', this.#config.checksEveryMs)
    const witness = await this.#witness()
    const { state, ...report } = await inSnapshot(pool, (client) => verifyLog(client, { witness }))
    return { object: 'verification', ...report, root: state?.root ?? null }
  }

  async #witness(): Promise<WitnessView | undefined> {
    if (!this.#config.witnessUrl) return undefined
    try {
      return await readWitness(this.#config.witnessUrl)
    } catch (error) {
      this.#logger.warn(`the witness could not be read: ${error instanceof Error ? error.message : String(error)}`)
      throw new ApiError(503, 'witness_unavailable', 'the witness could not be read, so try again in a minute', { 'retry-after': '60' })
    }
  }

  #pool(): pg.Pool {
    if (!this.#audit.pool) throw new ApiError(503, 'not_configured', 'AUDIT_DATABASE_URL is not set on this API')
    return this.#audit.pool
  }
}
