import { Body, Controller, HttpCode, Inject, Injectable, Logger, Post, type OnModuleDestroy } from '@nestjs/common'
import { verifyLog, WitnessClient, type WitnessedRoots } from '@carwash/audit-pg'
import { armFailpoints, disarmFailpoints, type FailpointName } from '@carwash/failpoints'
import { checkAudit, checkLedger, checkPayments, checkSequenced, readWitness } from '@carwash/invariants'
import { checkout, createPool } from '@carwash/pg'
import { IsIn } from 'class-validator'
import type pg from 'pg'
import { AdminOnly } from '../auth/access.guard.ts'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { ApiError } from '../http/api-error.ts'

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

function notYet(everyMs: number, last: number): ApiError | undefined {
  const wait = last + everyMs - Date.now()
  if (wait <= 0) return undefined
  return new ApiError(429, 'rate_limited', `this can run again in ${Math.ceil(wait / 1000)} s`, { 'retry-after': String(Math.ceil(wait / 1000)) })
}

@AdminOnly()
@Controller('v1/admin')
export class DashboardController {
  readonly #audit: AuditDatabase
  readonly #config: ApiConfig
  readonly #logger = new Logger('dashboard')
  #plugged = Number.NEGATIVE_INFINITY
  #checked = Number.NEGATIVE_INFINITY
  #verified = Number.NEGATIVE_INFINITY

  constructor(audit: AuditDatabase, @Inject(API_CONFIG) config: ApiConfig) {
    this.#audit = audit
    this.#config = config
  }

  @Post('plug')
  @HttpCode(202)
  plug(@Body() body: PlugBody) {
    const limited = notYet(this.#config.plugEveryMs, this.#plugged)
    if (limited) throw limited
    this.#plugged = Date.now()
    armFailpoints(new Map<FailpointName, number>([[body.failpoint, 1]]), (name) => {
      disarmFailpoints()
      this.#logger.warn(`pulling the plug at ${name}`)
      process.kill(process.pid, 'SIGKILL')
    })
    return { object: 'plug', failpoint: body.failpoint, pid: process.pid, armed_at: new Date().toISOString() }
  }

  @Post('checks')
  @HttpCode(200)
  async checks() {
    const pool = this.#pool()
    const limited = notYet(this.#config.checksEveryMs, this.#checked)
    if (limited) throw limited
    this.#checked = Date.now()
    const started = performance.now()
    const witness = this.#config.witnessUrl ? await readWitness(this.#config.witnessUrl) : undefined
    const results = [
      ...(await checkLedger(pool)),
      ...(await checkPayments(pool)),
      await checkAudit(pool, witness),
      await checkSequenced(pool, witness),
    ]
    return { object: 'invariant_checks', ran_at: new Date().toISOString(), ms: Math.round(performance.now() - started), witnessed: witness !== undefined, results }
  }

  @Post('verify')
  @HttpCode(200)
  async verify() {
    const pool = this.#pool()
    const limited = notYet(this.#config.checksEveryMs, this.#verified)
    if (limited) throw limited
    this.#verified = Date.now()
    let witness: WitnessedRoots | undefined
    if (this.#config.witnessUrl) {
      const client = new WitnessClient(this.#config.witnessUrl, '', 10_000)
      const key = await client.key()
      witness = { origin: key.origin, publicKey: key.public_key, checkpoints: await client.history() }
    }
    const lease = await checkout(pool)
    let broken = false
    try {
      await lease.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const report = await verifyLog(lease.client, { witness })
      await lease.client.query('COMMIT')
      const { state, ...rest } = report
      return { object: 'verification', ...rest, root: state?.root ?? null }
    } catch (error) {
      await lease.client.query('ROLLBACK').catch(() => {
        broken = true
      })
      throw error
    } finally {
      lease.release(broken)
    }
  }

  #pool(): pg.Pool {
    if (!this.#audit.pool) throw new ApiError(503, 'not_configured', 'AUDIT_DATABASE_URL is not set on this API')
    return this.#audit.pool
  }
}
