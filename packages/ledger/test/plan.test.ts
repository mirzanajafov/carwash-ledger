import { assert, describe, expect, it } from 'vitest'
import { InvalidJournalError, MAX_ENTRIES, planJournal, shardFor, type Account, type BalanceMode } from '../src/index.ts'

let nextId = 1n

function account(balanceMode: BalanceMode, currency = 'EUR', shards = 1): Account {
  const id = nextId++
  return { id, code: `a${id}`, type: 'asset', currency, balanceMode, shards }
}

function registry(...accounts: Account[]): Map<bigint, Account> {
  return new Map(accounts.map((a) => [a.id, a]))
}

describe('planJournal', () => {
  const a = account('locked')
  const b = account('locked')
  const usd = account('locked', 'USD')
  const accounts = registry(a, b, usd)

  it.each([
    ['too few entries', { externalRef: 'x', entries: [{ accountId: a.id, amount: 1n }] }],
    [
      'an empty external ref',
      {
        externalRef: '',
        entries: [
          { accountId: a.id, amount: 1n },
          { accountId: b.id, amount: -1n },
        ],
      },
    ],
    [
      'a zero amount',
      {
        externalRef: 'x',
        entries: [
          { accountId: a.id, amount: 0n },
          { accountId: b.id, amount: 0n },
        ],
      },
    ],
    [
      'an unknown account',
      {
        externalRef: 'x',
        entries: [
          { accountId: 999n, amount: 1n },
          { accountId: b.id, amount: -1n },
        ],
      },
    ],
    [
      'an amount out of range',
      {
        externalRef: 'x',
        entries: [
          { accountId: a.id, amount: 10n ** 16n },
          { accountId: b.id, amount: -(10n ** 16n) },
        ],
      },
    ],
    [
      'an unbalanced journal',
      {
        externalRef: 'x',
        entries: [
          { accountId: a.id, amount: 5n },
          { accountId: b.id, amount: -4n },
        ],
      },
    ],
    [
      'a journal balanced only across currencies',
      {
        externalRef: 'x',
        entries: [
          { accountId: a.id, amount: 5n },
          { accountId: usd.id, amount: -5n },
        ],
      },
    ],
  ])('rejects %s', (_, input) => {
    expect(() => planJournal(input, accounts)).toThrow(InvalidJournalError)
  })

  it('rejects more than the maximum number of entries', () => {
    const entries = Array.from({ length: MAX_ENTRIES + 2 }, (_, i) => ({ accountId: i % 2 === 0 ? a.id : b.id, amount: i % 2 === 0 ? 1n : -1n }))
    expect(() => planJournal({ externalRef: 'x', entries }, accounts)).toThrow(InvalidJournalError)
  })

  it('rejects a number where a bigint is required', () => {
    const entries = [
      { accountId: a.id, amount: 1 as unknown as bigint },
      { accountId: b.id, amount: -1n },
    ]
    expect(() => planJournal({ externalRef: 'x', entries }, accounts)).toThrow(InvalidJournalError)
  })

  it('aggregates deltas per account, drops zero deltas and sorts by account', () => {
    const plan = planJournal(
      {
        externalRef: 'agg',
        entries: [
          { accountId: b.id, amount: 7n },
          { accountId: a.id, amount: 3n },
          { accountId: a.id, amount: -3n },
          { accountId: b.id, amount: -7n },
          { accountId: a.id, amount: 2n },
          { accountId: b.id, amount: -2n },
        ],
      },
      accounts,
    )
    expect(plan.deltas).toEqual([
      { accountId: a.id, shard: 0, delta: 2n },
      { accountId: b.id, shard: 0, delta: -2n },
    ])
    expect(plan.locks).toEqual([
      { accountId: a.id, shard: 0 },
      { accountId: b.id, shard: 0 },
    ])
    expect(plan.isolation).toBe('read committed')
  })

  it('locks and updates per mode', () => {
    const locked = account('locked')
    const serializable = account('serializable')
    const derived = account('derived')
    const sharded = account('sharded', 'EUR', 8)
    const plan = planJournal(
      {
        externalRef: 'modes',
        entries: [
          { accountId: locked.id, amount: 10n },
          { accountId: serializable.id, amount: -3n },
          { accountId: derived.id, amount: -3n },
          { accountId: sharded.id, amount: -4n },
        ],
      },
      registry(locked, serializable, derived, sharded),
    )
    const shard = shardFor('modes', sharded.id, 8)
    expect(plan.isolation).toBe('serializable')
    expect(plan.deltas).toEqual([
      { accountId: locked.id, shard: 0, delta: 10n },
      { accountId: serializable.id, shard: 0, delta: -3n },
      { accountId: sharded.id, shard, delta: -4n },
    ])
    expect(plan.locks).toEqual([
      { accountId: locked.id, shard: 0 },
      { accountId: sharded.id, shard },
    ])
  })
})

describe('shardFor', () => {
  it('is deterministic and stays in range', () => {
    expect(shardFor('ref', 7n, 16)).toBe(shardFor('ref', 7n, 16))
    expect(shardFor('ref', 7n, 1)).toBe(0)
    for (let i = 0; i < 1000; i++) {
      const s = shardFor(`ref-${i}`, 7n, 16)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(16)
    }
  })

  it('spreads journals evenly over shards', () => {
    const counts = new Array<number>(16).fill(0)
    for (let i = 0; i < 16_000; i++) {
      const shard = shardFor(`capture:${i}`, 42n, 16)
      const before = counts[shard]
      assert(before !== undefined)
      counts[shard] = before + 1
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(800)
      expect(count).toBeLessThan(1200)
    }
  })
})
