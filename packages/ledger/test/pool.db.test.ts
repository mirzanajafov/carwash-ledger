import { setTimeout as sleep } from 'node:timers/promises'
import { firstRow } from '@carwash/pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkout } from '../src/index.ts'
import { capture, createModeAccounts, openLedger, type LedgerFixture } from './support.ts'

let ledger: LedgerFixture

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  ledger = await openLedger(2)
  cleanup.defer(() => ledger.close())
})

afterAll(() => cleanup.disposeAsync())

describe('a checked-out connection that dies between statements', () => {
  it('is caught instead of crashing the process, dropped from the pool, and the next posting works', async () => {
    const accounts = await createModeAccounts(ledger.app, 'locked')
    const lease = await checkout(ledger.app)
    const { pid } = firstRow(await lease.client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
    await ledger.admin.query('SELECT pg_terminate_backend($1)', [pid])
    for (let i = 0; i < 100 && !lease.failed; i++) await sleep(20)
    expect(lease.failed).toBe(true)
    lease.release()

    const posted = await ledger.poster.post({ externalRef: 'after-terminate', entries: capture(accounts, 0, 1000n, 30n) })
    expect(posted.attempts).toBe(1)
    expect(firstRow(await ledger.app.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).pid).not.toBe(pid)
  })
})
