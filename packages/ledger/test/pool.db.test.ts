import { setTimeout as sleep } from 'node:timers/promises'
import { checkout, firstRow, withTransaction, type Queryable, type TransactionOptions } from '@carwash/pg'
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

async function journalCount(ref: string): Promise<number> {
  return firstRow(await ledger.app.query<{ n: number }>('SELECT count(*)::int AS n FROM journals WHERE external_ref = $1', [ref])).n
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

describe('a transaction run by withTransaction', () => {
  it.each<[TransactionOptions, string, string]>([
    [{}, 'read committed', 'off'],
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

  it('rolls the work back and passes its error on', async () => {
    const failing = withTransaction(ledger.app, async (client) => {
      await client.query("INSERT INTO journals (external_ref) VALUES ('tx:work-failed')")
      throw new Error('the work failed')
    })
    await expect(failing).rejects.toThrow('the work failed')
    expect(await journalCount('tx:work-failed')).toBe(0)
  })

  it('fails when a swallowed statement error made COMMIT roll back, instead of returning as if it committed', async () => {
    const swallowed = withTransaction(ledger.app, async (client) => {
      await client.query("INSERT INTO journals (external_ref) VALUES ('tx:swallowed')")
      await client.query('SELECT 1 / 0').catch(() => undefined)
      return 'written'
    })
    await expect(swallowed).rejects.toThrow('rolled back at COMMIT')
    expect(await journalCount('tx:swallowed')).toBe(0)
  })

  it('drops a connection that died inside the work, so the next transaction on a pool of one works', async () => {
    const single = ledger.db.pool('ledger_app', 1)
    let killed = 0
    const dying = withTransaction(single, async (client) => {
      killed = await backendPid(client)
      await ledger.admin.query('SELECT pg_terminate_backend($1)', [killed])
      throw new Error('the connection died')
    })
    await expect(dying).rejects.toThrow('the connection died')
    expect(await withTransaction(single, backendPid)).not.toBe(killed)
  })
})
