import { Prisma, type PrismaClient } from '@carwash/db'
import type { AccountRegistry } from '../accounts.ts'
import { deltaParams, entryParams, lockParams, type JournalPlan } from '../plan.ts'
import type { RetryOptions } from '../retry.ts'
import { APPLY_DELTAS, INSERT_ENTRIES, INSERT_JOURNAL, LOCK_BALANCES, POST_JOURNAL } from '../sql.ts'
import type { JournalInput, PostedJournal, Poster } from '../types.ts'
import { expectApplied, postWith } from './common.ts'

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
    return postWith(this.#registry, input, this.#retry, (plan) =>
      this.#prisma.$transaction(async (tx) => {
        if (plan.locks.length > 0) await tx.$queryRawUnsafe(LOCK_BALANCES, ...lockParams(plan))
        return this.write(tx, plan)
      }, optionsFor(plan)),
    )
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
