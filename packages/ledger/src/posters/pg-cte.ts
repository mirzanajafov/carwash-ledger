import { failpoint } from '@carwash/failpoints'
import { firstRow, type Transaction, withTransaction } from '@carwash/pg'
import type pg from 'pg'
import { pgAccountLoader, type AccountRegistry } from '../accounts.ts'
import { InvalidJournalError } from '../errors.ts'
import { deltaParams, entryParams, lockParams, planJournal, type JournalPlan } from '../plan.ts'
import type { RetryOptions } from '../retry.ts'
import { LOCK_BALANCES, POST_JOURNAL } from '../sql.ts'
import { translateError } from '../translate.ts'
import type { JournalInput, PostedJournal, Poster } from '../types.ts'
import { expectApplied, postWith } from './common.ts'

async function writeJournal(client: Transaction, plan: JournalPlan): Promise<bigint> {
  if (plan.locks.length > 0) {
    await client.query(LOCK_BALANCES, lockParams(plan))
    failpoint('post.after_lock')
  }
  const row = firstRow(
    await client.query<{ id: string; balances: string }>(POST_JOURNAL, [
      plan.externalRef,
      plan.reversesId?.toString() ?? null,
      ...entryParams(plan),
      ...deltaParams(plan),
    ]),
  )
  expectApplied(Number(row.balances), plan)
  return BigInt(row.id)
}

export async function postInTransaction(client: Transaction, registry: AccountRegistry, input: JournalInput): Promise<bigint> {
  const accounts = await registry.resolve(
    input.entries.map((e) => e.accountId),
    pgAccountLoader(client),
  )
  const plan = planJournal(input, accounts)
  if (plan.isolation === 'serializable') {
    throw new InvalidJournalError('a journal touching serializable accounts needs its own transaction')
  }
  try {
    return await writeJournal(client, plan)
  } catch (error) {
    throw translateError(error, plan)
  }
}

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
    const committed = await withTransaction(
      this.#pool,
      async (client) => {
        const written = await writeJournal(client, plan)
        failpoint('post.before_commit')
        return written
      },
      { isolation: plan.isolation },
    )
    failpoint('post.after_commit')
    return committed
  }
}
