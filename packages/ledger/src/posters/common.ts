import type { AccountRegistry } from '../accounts.ts'
import { LedgerRuleError } from '../errors.ts'
import { planJournal, type JournalPlan } from '../plan.ts'
import { DEFAULT_RETRY, withRetry, type RetryOptions } from '../retry.ts'
import { translateError } from '../translate.ts'
import type { JournalInput, PostedJournal } from '../types.ts'

export async function postWith(
  registry: AccountRegistry,
  input: JournalInput,
  retry: RetryOptions | undefined,
  attempt: (plan: JournalPlan) => Promise<bigint>,
): Promise<PostedJournal> {
  const plan = planJournal(input, await registry.resolve(input.entries.map((e) => e.accountId)))
  try {
    const { value, attempts } = await withRetry(() => attempt(plan), retry ?? DEFAULT_RETRY)
    return { id: value, externalRef: plan.externalRef, attempts }
  } catch (error) {
    throw translateError(error, plan)
  }
}

export function expectApplied(applied: number, plan: JournalPlan): void {
  if (applied !== plan.deltas.length) {
    throw new LedgerRuleError('LG010', `expected ${plan.deltas.length} balance rows, updated ${applied}`)
  }
}

export function beginStatement(plan: JournalPlan): string {
  return plan.isolation === 'serializable' ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN'
}
