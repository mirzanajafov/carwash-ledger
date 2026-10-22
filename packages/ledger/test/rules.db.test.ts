import { firstRow, withTransaction, type Transaction } from '@carwash/pg'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { AlreadyReversedError, DuplicateJournalError, InvalidJournalError, readBalance, reversalOf } from '../src/index.ts'
import { capture, createModeAccounts, openLedger, sqlState, type LedgerFixture, type ModeAccounts } from './support.ts'

let ledger: LedgerFixture
let eur: ModeAccounts
let usd: ModeAccounts

async function insertJournal(client: Transaction, ref: string): Promise<string> {
  return firstRow(await client.query<{ id: string }>('INSERT INTO journals (external_ref) VALUES ($1) RETURNING id::text', [ref])).id
}

async function insertEntry(client: Transaction, journalId: string, accountId: bigint, amount: bigint): Promise<void> {
  await client.query('INSERT INTO entries (journal_id, account_id, amount) VALUES ($1, $2, $3)', [journalId, accountId.toString(), amount.toString()])
}

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  ledger = await openLedger()
  cleanup.defer(() => ledger.close())
  eur = await createModeAccounts(ledger.app, 'locked')
  usd = await createModeAccounts(ledger.app, 'locked', { currency: 'USD' })
})

afterAll(() => cleanup.disposeAsync())

describe('what the database enforces', () => {
  it('rejects an unbalanced journal at commit', async () => {
    const state = await sqlState(
      withTransaction(ledger.app, async (c) => {
        const id = await insertJournal(c, 'raw-unbalanced')
        await insertEntry(c, id, eur.receivable.id, 100n)
        await insertEntry(c, id, eur.fees.id, -99n)
      }),
    )
    expect(state).toBe('LG002')
  })

  it('rejects a journal balanced across currencies but not within each', async () => {
    const state = await sqlState(
      withTransaction(ledger.app, async (c) => {
        const id = await insertJournal(c, 'raw-cross-currency')
        await insertEntry(c, id, eur.receivable.id, 100n)
        await insertEntry(c, id, usd.receivable.id, -100n)
      }),
    )
    expect(state).toBe('LG002')
  })

  it('rejects a journal without entries', async () => {
    const state = await sqlState(
      withTransaction(ledger.app, async (c) => {
        await insertJournal(c, 'raw-empty')
      }),
    )
    expect(state).toBe('LG003')
  })

  it('rejects entries added to a journal from an earlier transaction', async () => {
    const posted = await ledger.poster.post({ externalRef: 'closed', entries: capture(eur, 0, 1000n, 30n) })
    const state = await sqlState(
      withTransaction(ledger.app, async (c) => {
        await insertEntry(c, posted.id.toString(), eur.receivable.id, 5n)
        await insertEntry(c, posted.id.toString(), eur.fees.id, -5n)
      }),
    )
    expect(state).toBe('LG004')
  })

  it('stamps the transaction id itself, whatever the client sends', async () => {
    await withTransaction(ledger.app, async (c) => {
      const { id, ours } = firstRow(
        await c.query<{ id: string; ours: boolean }>(
          `INSERT INTO journals (external_ref, created_xid) VALUES ('forged', '3'::xid8)
         RETURNING id::text, created_xid = pg_current_xact_id() AS ours`,
        ),
      )
      expect(ours).toBe(true)
      const entry = await c.query<{ ours: boolean }>(
        `INSERT INTO entries (journal_id, account_id, amount, created_xid) VALUES ($1, $2, 7, '3'::xid8)
         RETURNING created_xid = pg_current_xact_id() AS ours`,
        [id, eur.receivable.id.toString()],
      )
      expect(entry.rows).toEqual([{ ours: true }])
      await insertEntry(c, id, eur.fees.id, -7n)
    })
  })

  it('gives the app role no way to change or remove history', async () => {
    expect(await sqlState(ledger.app.query('UPDATE entries SET amount = amount + 1'))).toBe('42501')
    expect(await sqlState(ledger.app.query('DELETE FROM entries'))).toBe('42501')
    expect(await sqlState(ledger.app.query(`UPDATE journals SET external_ref = 'x'`))).toBe('42501')
    expect(await sqlState(ledger.app.query('DELETE FROM journals'))).toBe('42501')
    expect(await sqlState(ledger.app.query('TRUNCATE entries'))).toBe('42501')
  })

  it('stops even the owner from changing or removing history', async () => {
    await ledger.poster.post({ externalRef: 'owner-target', entries: capture(eur, 1, 500n, 10n) })
    expect(await sqlState(ledger.owner.query('UPDATE entries SET amount = amount + 1'))).toBe('LG001')
    expect(await sqlState(ledger.owner.query('DELETE FROM entries'))).toBe('LG001')
    expect(await sqlState(ledger.owner.query('TRUNCATE entries'))).toBe('LG001')
    expect(await sqlState(ledger.owner.query(`UPDATE journals SET external_ref = external_ref || 'x'`))).toBe('LG001')
    expect(await sqlState(ledger.owner.query(`UPDATE accounts SET currency = 'GBP'`))).toBe('LG001')
  })

  it('lets an update through when no protected column changes', async () => {
    expect(await sqlState(ledger.owner.query('UPDATE entries SET amount = amount'))).toBeUndefined()
  })
})

describe('posting', () => {
  it('rejects an unbalanced journal before it reaches the database', async () => {
    await expect(
      ledger.poster.post({
        externalRef: 'code-unbalanced',
        entries: [
          { accountId: eur.receivable.id, amount: 10n },
          { accountId: eur.fees.id, amount: -9n },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidJournalError)
  })

  it('rejects a second journal with the same external ref, in every poster', async () => {
    for (const poster of ledger.posters) {
      const ref = `dup-${poster.name}`
      await poster.post({ externalRef: ref, entries: capture(eur, 2, 2000n, 50n) })
      await expect(poster.post({ externalRef: ref, entries: capture(eur, 2, 2000n, 50n) })).rejects.toBeInstanceOf(DuplicateJournalError)
    }
  })

  it('reverses a journal once and restores every balance', async () => {
    const accounts = await createModeAccounts(ledger.app, 'locked', { prefix: 'reversal:' })
    const posted = await ledger.poster.post({ externalRef: 'to-reverse', entries: capture(accounts, 0, 1500n, 40n) })
    await ledger.poster.post(await reversalOf(ledger.app, posted.id, 'reverse-1'))
    const [merchant] = accounts.merchants
    assert(merchant)
    for (const account of [accounts.receivable, accounts.fees, merchant]) {
      expect(await readBalance(ledger.app, account)).toBe(0n)
    }
    await expect(ledger.poster.post(await reversalOf(ledger.app, posted.id, 'reverse-2'))).rejects.toBeInstanceOf(AlreadyReversedError)
  })
})
