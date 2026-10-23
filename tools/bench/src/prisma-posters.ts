import { Prisma, type PrismaClient } from '@carwash/db'
import {
  deltaParams,
  entryParams,
  lockParams,
  type AccountRegistry,
  type JournalInput,
  type JournalPlan,
  type PostedJournal,
  type Poster,
} from '@carwash/ledger'
import { expectApplied, LOCK_BALANCES, POST_JOURNAL, postWith } from '@carwash/ledger/driver'
import type { RetryOptions } from '@carwash/pg'
import * as z from 'zod/mini'

const INSERT_JOURNAL = `
INSERT INTO journals (external_ref, reverses_id)
VALUES ($1, $2::bigint)
RETURNING id`

const INSERT_ENTRIES = `
INSERT INTO entries (journal_id, account_id, amount)
SELECT $1::bigint, t.account_id, t.amount
FROM unnest($2::bigint[], $3::bigint[]) AS t(account_id, amount)`

const APPLY_DELTAS = `
UPDATE balances AS b
SET amount = b.amount + t.delta, version = b.version + 1
FROM unnest($1::bigint[], $2::int[], $3::bigint[]) AS t(account_id, shard, delta)
WHERE b.account_id = t.account_id AND b.shard = t.shard`

const PRISMA_TO_SQLSTATE: Readonly<Record<string, string>> = {
  P2002: '23505',
  P2034: '40001',
}

const AdapterError = z.object({
  driverAdapterError: z.object({ cause: z.object({ originalCode: z.string(), originalMessage: z.optional(z.string()) }) }),
})

export function asPgError(error: unknown): unknown {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return error
  const adapter = AdapterError.safeParse(error.meta)
  const cause = adapter.success ? adapter.data.driverAdapterError.cause : undefined
  const code = cause?.originalCode ?? PRISMA_TO_SQLSTATE[error.code]
  if (code === undefined) return error
  return Object.assign(new Error(cause?.originalMessage ?? error.message, { cause: error }), { code })
}

type Tx = Prisma.TransactionClient

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 }

function optionsFor(plan: JournalPlan) {
  return plan.isolation === 'serializable' ? { ...TX_OPTIONS, isolationLevel: Prisma.TransactionIsolationLevel.Serializable } : TX_OPTIONS
}

abstract class PrismaPoster implements Poster {
  abstract readonly name: string
  readonly #prisma: PrismaClient
  readonly #registry: AccountRegistry
  readonly #retry: RetryOptions | undefined

  constructor(prisma: PrismaClient, registry: AccountRegistry, retry?: RetryOptions) {
    this.#prisma = prisma
    this.#registry = registry
    this.#retry = retry
  }

  post(input: JournalInput): Promise<PostedJournal> {
    const attempt = (plan: JournalPlan) =>
      this.#prisma
        .$transaction(async (tx) => {
          if (plan.locks.length > 0) await tx.$queryRawUnsafe(LOCK_BALANCES, ...lockParams(plan))
          return this.write(tx, plan)
        }, optionsFor(plan))
        .catch((error: unknown) => {
          throw asPgError(error)
        })
    return postWith(this.#registry, input, attempt, this.#retry)
  }

  protected abstract write(tx: Tx, plan: JournalPlan): Promise<bigint>
}

export class PrismaApiPoster extends PrismaPoster {
  readonly name = 'prisma-api'

  protected async write(tx: Tx, plan: JournalPlan): Promise<bigint> {
    const journal = await tx.journal.create({
      data: { externalRef: plan.externalRef, reversesId: plan.reversesId },
      select: { id: true },
    })
    await tx.entry.createMany({
      data: plan.entries.map((e) => ({ journalId: journal.id, accountId: e.accountId, amount: e.amount })),
    })
    for (const d of plan.deltas) {
      await tx.balance.update({
        where: { accountId_shard: { accountId: d.accountId, shard: d.shard } },
        data: { amount: { increment: d.delta }, version: { increment: 1 } },
        select: { version: true },
      })
    }
    return journal.id
  }
}

export class PrismaSqlPoster extends PrismaPoster {
  readonly name = 'prisma-sql'

  protected async write(tx: Tx, plan: JournalPlan): Promise<bigint> {
    const [journal] = await tx.$queryRawUnsafe<{ id: bigint }[]>(INSERT_JOURNAL, plan.externalRef, plan.reversesId?.toString() ?? null)
    if (!journal) throw new Error(`inserting journal ${plan.externalRef} returned no row`)
    await tx.$executeRawUnsafe(INSERT_ENTRIES, journal.id.toString(), ...entryParams(plan))
    if (plan.deltas.length > 0) expectApplied(await tx.$executeRawUnsafe(APPLY_DELTAS, ...deltaParams(plan)), plan)
    return journal.id
  }
}

export class PrismaCtePoster extends PrismaPoster {
  readonly name = 'prisma-cte'

  protected async write(tx: Tx, plan: JournalPlan): Promise<bigint> {
    const [row] = await tx.$queryRawUnsafe<{ id: bigint; balances: bigint }[]>(
      POST_JOURNAL,
      plan.externalRef,
      plan.reversesId?.toString() ?? null,
      ...entryParams(plan),
      ...deltaParams(plan),
    )
    if (!row) throw new Error(`posting journal ${plan.externalRef} returned no row`)
    expectApplied(Number(row.balances), plan)
    return row.id
  }
}
