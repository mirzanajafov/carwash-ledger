import { checkLedger, violations } from '@carwash/invariants'
import { setTimeout as sleep } from 'node:timers/promises'
import { checkout, firstRow, inRollback, withTransaction } from '@carwash/pg'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { AccountRegistry, DuplicateJournalError, InvalidJournalError, pgAccountLoader, postInTransaction } from '../src/index.ts'
import { capture, createModeAccounts, openLedger, sqlState, type LedgerFixture, type ModeAccounts } from './support.ts'

let ledger: LedgerFixture
let registry: AccountRegistry
let locked: ModeAccounts
let sharded: ModeAccounts

async function storedBalance(accountId: bigint): Promise<bigint> {
  const { amount } = firstRow(
    await ledger.app.query<{ amount: string }>('SELECT coalesce(sum(amount), 0) AS amount FROM balances WHERE account_id = $1', [accountId.toString()]),
  )
  return BigInt(amount)
}

async function journalCount(ref: string): Promise<number> {
  return firstRow(await ledger.app.query<{ n: number }>('SELECT count(*)::int AS n FROM journals WHERE external_ref = $1', [ref])).n
}

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  ledger = await openLedger(4)
  cleanup.defer(() => ledger.close())
  registry = new AccountRegistry(pgAccountLoader(ledger.app))
  locked = await createModeAccounts(ledger.app, 'locked', { prefix: 'tx:' })
  sharded = await createModeAccounts(ledger.app, 'sharded', { prefix: 'tx:' })
})

afterAll(() => cleanup.disposeAsync())

describe('postInTransaction', () => {
  it('commits and rolls back with the transaction it was given', async () => {
    const lease = await checkout(ledger.app)
    await lease.client.query('BEGIN')
    await postInTransaction(lease.client, registry, { externalRef: 'tx:rolled-back', entries: capture(sharded, 0, 1000n, 30n) })
    await lease.client.query('ROLLBACK')
    expect(await journalCount('tx:rolled-back')).toBe(0)
    expect(await storedBalance(sharded.receivable.id)).toBe(0n)

    await lease.client.query('BEGIN')
    const id = await postInTransaction(lease.client, registry, { externalRef: 'tx:committed', entries: capture(sharded, 0, 1000n, 30n) })
    await lease.client.query('COMMIT')
    lease.release()
    expect(id).toBeGreaterThan(0n)
    expect(await storedBalance(sharded.receivable.id)).toBe(1000n)
    const [merchant] = sharded.merchants
    assert(merchant)
    expect(await storedBalance(merchant.id)).toBe(-970n)
    expect(violations(await checkLedger(ledger.admin))).toEqual([])
  })

  it("looks unknown accounts up on the transaction's own connection, so a full pool cannot stall it", async () => {
    const single = ledger.db.pool('ledger_app', 1)
    const cold = new AccountRegistry(pgAccountLoader(single))
    await withTransaction(single, async (client) => {
      const posted = postInTransaction(client, cold, { externalRef: 'tx:full-pool', entries: capture(locked, 1, 500n, 15n) })
      const stalled = sleep(5000, undefined, { ref: false }).then(() => {
        throw new Error('the posting waited for a second connection from its own full pool')
      })
      expect(await Promise.race([posted, stalled])).toBeGreaterThan(0n)
    })
    expect(await journalCount('tx:full-pool')).toBe(1)
  })

  it('holds a locked account until the outer transaction ends', async () => {
    const first = await checkout(ledger.app)
    const second = await checkout(ledger.app)
    try {
      await first.client.query('BEGIN')
      await postInTransaction(first.client, registry, { externalRef: 'tx:holder', entries: capture(locked, 1, 500n, 10n) })
      await second.client.query('BEGIN')
      await second.client.query(`SET LOCAL lock_timeout = '200ms'`)
      const blocked = postInTransaction(second.client, registry, { externalRef: 'tx:waiter', entries: capture(locked, 1, 500n, 10n) })
      expect(await sqlState(blocked)).toBe('55P03')
      await second.client.query('ROLLBACK')
      await first.client.query('COMMIT')
    } finally {
      first.release()
      second.release()
    }
    expect(await journalCount('tx:holder')).toBe(1)
    expect(await journalCount('tx:waiter')).toBe(0)
  })

  it('reports a second journal with the same reference as a duplicate', async () => {
    await inRollback(ledger.app, async (client) => {
      await expect(postInTransaction(client, registry, { externalRef: 'tx:committed', entries: capture(sharded, 0, 1000n, 30n) })).rejects.toBeInstanceOf(
        DuplicateJournalError,
      )
    })
  })

  it('rejects an unbalanced journal before sending anything, so the outer transaction can go on', async () => {
    await withTransaction(ledger.app, async (client) => {
      await expect(
        postInTransaction(client, registry, {
          externalRef: 'tx:unbalanced',
          entries: [
            { accountId: sharded.receivable.id, amount: 100n },
            { accountId: sharded.fees.id, amount: -99n },
          ],
        }),
      ).rejects.toBeInstanceOf(InvalidJournalError)
      await postInTransaction(client, registry, { externalRef: 'tx:after-unbalanced', entries: capture(sharded, 2, 100n, 1n) })
    })
    expect(await journalCount('tx:unbalanced')).toBe(0)
    expect(await journalCount('tx:after-unbalanced')).toBe(1)
  })

  it('refuses accounts that need a serializable transaction of their own', async () => {
    const serializable = await createModeAccounts(ledger.app, 'serializable', { prefix: 'tx:', merchants: 1 })
    await inRollback(ledger.app, async (client) => {
      await expect(postInTransaction(client, registry, { externalRef: 'tx:serializable', entries: capture(serializable, 0, 100n, 1n) })).rejects.toBeInstanceOf(
        InvalidJournalError,
      )
    })
  })
})
