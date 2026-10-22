import { InvalidJournalError } from './errors.ts'
import type { Account, EntryInput, JournalInput } from './types.ts'

export const MAX_ENTRIES = 64
export const MAX_ABS_AMOUNT = 10n ** 15n
export const MAX_EXTERNAL_REF_LENGTH = 200

export interface BalanceTarget {
  accountId: bigint
  shard: number
}

export interface BalanceDelta extends BalanceTarget {
  delta: bigint
}

export type Isolation = 'read committed' | 'serializable'

export interface JournalPlan {
  externalRef: string
  reversesId: bigint | null
  entries: readonly EntryInput[]
  locks: readonly BalanceTarget[]
  deltas: readonly BalanceDelta[]
  isolation: Isolation
}

export function shardFor(externalRef: string, accountId: bigint, shards: number): number {
  if (shards <= 1) return 0
  let hash = 0x811c9dc5
  for (const char of `${accountId}:${externalRef}`) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % shards
}

function compareTargets(a: BalanceTarget, b: BalanceTarget): number {
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1
  return a.shard - b.shard
}

export function planJournal(input: JournalInput, accounts: ReadonlyMap<bigint, Account>): JournalPlan {
  const { externalRef, entries } = input
  if (typeof externalRef !== 'string' || externalRef.length === 0 || externalRef.length > MAX_EXTERNAL_REF_LENGTH) {
    throw new InvalidJournalError(`external ref must be 1 to ${MAX_EXTERNAL_REF_LENGTH} characters`)
  }
  if (entries.length < 2 || entries.length > MAX_ENTRIES) {
    throw new InvalidJournalError(`a journal needs 2 to ${MAX_ENTRIES} entries, got ${entries.length}`)
  }

  const totals = new Map<string, bigint>()
  const deltas = new Map<string, BalanceDelta>()
  let isolation: Isolation = 'read committed'
  const locked = new Set<string>()

  for (const entry of entries) {
    if (typeof entry.amount !== 'bigint' || entry.amount === 0n) {
      throw new InvalidJournalError('every entry needs a non-zero bigint amount')
    }
    if (entry.amount > MAX_ABS_AMOUNT || entry.amount < -MAX_ABS_AMOUNT) {
      throw new InvalidJournalError(`entry amount ${entry.amount} is out of range`)
    }
    const account = accounts.get(entry.accountId)
    if (account === undefined) throw new InvalidJournalError(`unknown account ${entry.accountId}`)

    totals.set(account.currency, (totals.get(account.currency) ?? 0n) + entry.amount)
    if (account.balanceMode === 'serializable') isolation = 'serializable'
    if (account.balanceMode === 'derived') continue

    const shard = account.balanceMode === 'sharded' ? shardFor(externalRef, account.id, account.shards) : 0
    const key = `${account.id}:${shard}`
    const existing = deltas.get(key)
    if (existing === undefined) deltas.set(key, { accountId: account.id, shard, delta: entry.amount })
    else existing.delta += entry.amount
    if (account.balanceMode === 'locked' || account.balanceMode === 'sharded') locked.add(key)
  }

  for (const [currency, total] of totals) {
    if (total !== 0n) throw new InvalidJournalError(`entries do not balance in ${currency}: off by ${total}`)
  }

  const applied = [...deltas.entries()].filter(([, d]) => d.delta !== 0n).sort(([, a], [, b]) => compareTargets(a, b))

  return {
    externalRef,
    reversesId: input.reversesId ?? null,
    entries: entries.map((e) => ({ accountId: e.accountId, amount: e.amount })),
    locks: applied.filter(([key]) => locked.has(key)).map(([, d]) => ({ accountId: d.accountId, shard: d.shard })),
    deltas: applied.map(([, d]) => d),
    isolation,
  }
}

export function lockParams(plan: JournalPlan): [string[], number[]] {
  return [plan.locks.map((l) => l.accountId.toString()), plan.locks.map((l) => l.shard)]
}

export function entryParams(plan: JournalPlan): [string[], string[]] {
  return [plan.entries.map((e) => e.accountId.toString()), plan.entries.map((e) => e.amount.toString())]
}

export function deltaParams(plan: JournalPlan): [string[], number[], string[]] {
  return [plan.deltas.map((d) => d.accountId.toString()), plan.deltas.map((d) => d.shard), plan.deltas.map((d) => d.delta.toString())]
}
