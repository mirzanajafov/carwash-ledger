import { constraintOf, errorText, sqlStateOf } from '@carwash/pg'
import { AlreadyReversedError, DuplicateJournalError, LedgerError, LedgerRuleError } from './errors.ts'
import type { JournalPlan } from './plan.ts'

export function translateError(error: unknown, plan: JournalPlan): unknown {
  if (error instanceof LedgerError) return error
  const state = sqlStateOf(error)
  if (state === undefined) return error
  if (state === '23505') {
    const constraint = constraintOf(error)
    if (constraint === 'journals_reverses_id_key' && plan.reversesId !== null) return new AlreadyReversedError(plan.reversesId, { cause: error })
    if (constraint === 'journals_external_ref_key') return new DuplicateJournalError(plan.externalRef, { cause: error })
  }
  if (state.startsWith('LG')) return new LedgerRuleError(state, errorText(error).split(' | ')[0] ?? state, { cause: error })
  return error
}
