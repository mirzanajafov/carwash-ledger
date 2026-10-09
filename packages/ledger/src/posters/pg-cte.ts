import type pg from 'pg'
import type { AccountRegistry } from '../accounts.ts'
import { deltaParams, entryParams, lockParams, type JournalPlan } from '../plan.ts'
import type { RetryOptions } from '../retry.ts'
import { LOCK_BALANCES, POST_JOURNAL } from '../sql.ts'
import type { JournalInput, PostedJournal, Poster } from '../types.ts'
import { beginStatement, expectApplied, postWith } from './common.ts'

export class PgCtePoster implements Poster {
  readonly name = 'pg-cte'
  readonly #pool: pg.Pool
  readonly #registry: AccountRegistry
  readonly #retry: RetryOptions | undefined

  constructor(pool: pg.Pool, registry: AccountRegistry, retry?: RetryOptions) {
    this.#pool = pool
    this.#registry = registry
    this.#retry = retry
  }

  post(input: JournalInput): Promise<PostedJournal> {
    return postWith(this.#registry, input, this.#retry, (plan) => this.#attempt(plan))
  }

  async #attempt(plan: JournalPlan): Promise<bigint> {
    const client = await this.#pool.connect()
    let broken = false
    try {
      await client.query(beginStatement(plan))
      if (plan.locks.length > 0) await client.query(LOCK_BALANCES, lockParams(plan))
      const result = await client.query<{ id: string; balances: string }>(POST_JOURNAL, [
        plan.externalRef,
        plan.reversesId?.toString() ?? null,
        ...entryParams(plan),
        ...deltaParams(plan),
      ])
      const row = result.rows[0]!
      expectApplied(Number(row.balances), plan)
      await client.query('COMMIT')
      return BigInt(row.id)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        broken = true
      })
      throw error
    } finally {
      client.release(broken)
    }
  }
}
