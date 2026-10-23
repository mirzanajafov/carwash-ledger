import { setTimeout as sleep } from 'node:timers/promises'
import { checkout, createPool, firstRow, inRollback, withTransaction, type Queryable, type TransactionOptions } from '@carwash/pg'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, createModeAccounts, openLedger, type LedgerFixture } from './support.ts'

let ledger: LedgerFixture

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  ledger = await openLedger(2)
  cleanup.defer(() => ledger.close())
})

afterAll(() => cleanup.disposeAsync())

async function backendPid(db: Queryable): Promise<number> {
  return firstRow(await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).pid
}

describe('a checked-out connection that dies between statements', () => {
  it('is caught instead of crashing the process, dropped from the pool, and the next posting works', async () => {
    const accounts = await createModeAccounts(ledger.app, 'locked')
    const lease = await checkout(ledger.app)
    const pid = await backendPid(lease.client)
    await ledger.admin.query('SELECT pg_terminate_backend($1)', [pid])
    for (let i = 0; i < 100 && !lease.failed; i++) await sleep(20)
    expect(lease.failed).toBe(true)
    lease.release()

    const posted = await ledger.poster.post({ externalRef: 'after-terminate', entries: capture(accounts, 0, 1000n, 30n) })
    expect(posted.attempts).toBe(1)
    expect(await backendPid(ledger.app)).not.toBe(pid)
  })
})

describe('a transaction run by withTransaction or inRollback', () => {
  let single: pg.Pool

  beforeAll(async () => {
    await ledger.admin.query('CREATE TABLE tx_probe (note text NOT NULL)')
    single = ledger.db.pool('admin', 1)
  })

  async function notes(): Promise<string[]> {
    return (await single.query<{ note: string }>('SELECT note FROM tx_probe')).rows.map((row) => row.note)
  }

  it.each<[TransactionOptions, string, string]>([
    [{}, 'read committed', 'off'],
    [{ isolation: 'read committed' }, 'read committed', 'off'],
    [{ isolation: 'serializable' }, 'serializable', 'off'],
    [{ isolation: 'repeatable read', readOnly: true }, 'repeatable read', 'on'],
    [{ readOnly: true }, 'read committed', 'on'],
  ])('begins %o as %s with read only %s', async (options, isolation, readOnly) => {
    const settings = await withTransaction(
      ledger.app,
      async (client) =>
        firstRow(
          await client.query<{ isolation: string; read_only: string }>(
            "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only",
          ),
        ),
      options,
    )
    expect(settings).toEqual({ isolation, read_only: readOnly })
  })

  it('commits the work, or rolls it back and passes its error on', async () => {
    await withTransaction(single, (client) => client.query("INSERT INTO tx_probe VALUES ('committed')"))
    const failing = withTransaction(single, async (client) => {
      await client.query("INSERT INTO tx_probe VALUES ('work-failed')")
      throw new Error('the work failed')
    })
    await expect(failing).rejects.toThrow('the work failed')
    expect(await notes()).toEqual(['committed'])
  })

  it('fails when a swallowed statement error made COMMIT roll back, instead of returning as if it committed', async () => {
    const swallowed = withTransaction(single, async (client) => {
      await client.query("INSERT INTO tx_probe VALUES ('swallowed')")
      await client.query('SELECT 1 / 0').catch(() => undefined)
      return 'written'
    })
    await expect(swallowed).rejects.toThrow('rolled back at COMMIT')
    expect(await notes()).not.toContain('swallowed')
  })

  it('rolls back what inRollback did, and still returns the value', async () => {
    const value = await inRollback(single, async (client) => {
      await client.query("INSERT INTO tx_probe VALUES ('rolled-back')")
      return (await client.query('SELECT note FROM tx_probe')).rowCount
    })
    expect(value).toBeGreaterThan(0)
    expect(await notes()).not.toContain('rolled-back')
  })

  it('drops a connection that died inside the work, so the next transaction on a pool of one works', async () => {
    let killed = 0
    const dying = withTransaction(single, async (client) => {
      killed = await backendPid(client)
      await ledger.admin.query('SELECT pg_terminate_backend($1, 5000)', [killed])
      throw new Error('the connection died')
    })
    await expect(dying).rejects.toThrow('the connection died')
    expect(await withTransaction(single, backendPid)).not.toBe(killed)
  })

  it('drops a connection whose ROLLBACK failed although it is still open', async () => {
    const impatient = createPool({ connectionString: ledger.db.url('admin'), max: 1, query_timeout: 1000 })
    cleanup.defer(() => impatient.end())
    let first = 0
    const stuck = withTransaction(impatient, async (client) => {
      first = await backendPid(client)
      void client.query('SELECT pg_sleep(5)').catch(() => undefined)
      throw new Error('the work gave up')
    })
    await expect(stuck).rejects.toThrow('the work gave up')
    expect(await withTransaction(impatient, backendPid)).not.toBe(first)
  })
})
