import { AccountRegistry, createAccount, pgAccountLoader, postInTransaction, type Account } from '@carwash/ledger'
import { checkout, firstRow } from '@carwash/pg'
import { createTestDatabase, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { afterAll, assert, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { LANES, Relay, RELAY_DEFAULTS, relayOnce, writeEvent, writeJournalEvents, type NewEvent, type OutboxRow, type Publisher } from '../src/index.ts'

let db: TestDatabase
let app: pg.Pool

class Recorder implements Publisher {
  readonly batches: OutboxRow[][] = []
  failNext = false
  get rows(): OutboxRow[] {
    return this.batches.flat()
  }
  async publish(rows: readonly OutboxRow[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('broker unavailable')
    }
    this.batches.push([...rows])
  }
}

async function commit(events: readonly NewEvent[]): Promise<void> {
  const lease = await checkout(app)
  try {
    await lease.client.query('BEGIN')
    for (const event of events) await writeEvent(lease.client, event)
    await lease.client.query('COMMIT')
  } finally {
    lease.release()
  }
}

async function addEvents(keys: readonly string[]): Promise<void> {
  await commit(keys.map((key) => ({ topic: 'payments', key, type: 'test.event', payload: { key } })))
}

async function unpublished(): Promise<number> {
  return firstRow(await app.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')).n
}

async function once(publisher: Publisher) {
  const lease = await checkout(app)
  try {
    return await relayOnce(lease.client, publisher)
  } finally {
    lease.release()
  }
}

async function laneOf(key: string): Promise<number> {
  return firstRow(await app.query<{ lane: number }>('SELECT lane FROM outbox WHERE key = $1 LIMIT 1', [key])).lane
}

beforeAll(async () => {
  db = await createTestDatabase()
  app = db.pool('ledger_app', 12)
})

afterAll(async () => {
  await db.drop()
})

beforeEach(async () => {
  await app.query('DELETE FROM outbox')
})

describe('the outbox', () => {
  it('writes one ledger event per entry, keyed by account, in the transaction that posts the journal', async () => {
    const receivable: Account = await createAccount(app, { code: 'ob:receivable', type: 'asset', currency: 'EUR', balanceMode: 'locked' })
    const payable: Account = await createAccount(app, { code: 'ob:payable', type: 'liability', currency: 'EUR', balanceMode: 'locked' })
    const registry = new AccountRegistry(pgAccountLoader(app))
    const post = async (ref: string, commit: boolean) => {
      const lease = await checkout(app)
      try {
        await lease.client.query('BEGIN')
        const journalId = await postInTransaction(lease.client, registry, {
          externalRef: ref,
          entries: [
            { accountId: receivable.id, amount: 1500n },
            { accountId: payable.id, amount: -1500n },
          ],
        })
        expect(await writeJournalEvents(lease.client, journalId)).toBe(2)
        await lease.client.query(commit ? 'COMMIT' : 'ROLLBACK')
        return journalId
      } finally {
        lease.release()
      }
    }
    await post('ob:rolled-back', false)
    expect(await unpublished()).toBe(0)
    const journalId = await post('ob:kept', true)
    const { rows } = await app.query<{ topic: string; key: string; type: string; payload: Record<string, string> }>(
      'SELECT topic, key, type, payload FROM outbox ORDER BY id',
    )
    expect(rows).toMatchObject([
      { topic: 'ledger', key: receivable.id.toString(), type: 'entry.posted' },
      {
        topic: 'ledger',
        key: payable.id.toString(),
        type: 'entry.posted',
        payload: { journal_id: journalId.toString(), external_ref: 'ob:kept', account: 'ob:payable', currency: 'EUR', amount: '-1500' },
      },
    ])
  })

  it('writes an event on the client it is given, so rolling back the transaction takes the event back', async () => {
    const lease = await checkout(app)
    try {
      await lease.client.query('BEGIN')
      await writeEvent(lease.client, { topic: 'payments', key: 'rolled-back', type: 'test.event', payload: {} })
      await lease.client.query('ROLLBACK')
    } finally {
      lease.release()
    }
    expect(await unpublished()).toBe(0)
  })

  it('refuses the pool at compile time, so an event cannot be written in an autocommit of its own by accident', () => {
    expectTypeOf<pg.Pool>().not.toExtend<Parameters<typeof writeEvent>[0]>()
    expectTypeOf<pg.Pool>().not.toExtend<Parameters<typeof writeJournalEvents>[0]>()
  })

  it('puts every key in one fixed lane', async () => {
    await addEvents(['a', 'b', 'a', 'c', 'a'])
    const { rows } = await app.query<{ key: string; lanes: number }>('SELECT key, count(DISTINCT lane)::int AS lanes FROM outbox GROUP BY key')
    expect(rows.every((row) => row.lanes === 1)).toBe(true)
    const { rows: spread } = await app.query<{ lanes: number }>(
      `SELECT count(DISTINCT (hashtextextended(k::text, 0) & ${LANES - 1}))::int AS lanes FROM generate_series(1, 1000) AS k`,
    )
    expect(spread).toEqual([{ lanes: LANES }])
  })
})

describe('relayOnce', () => {
  it('publishes every free lane in one batch, in id order, and marks what it published', async () => {
    await addEvents(['k1', 'k2', 'k1', 'k3', 'k1'])
    const publisher = new Recorder()
    const relayed = await once(publisher)
    assert(relayed)
    const lanes = [...new Set(await Promise.all(['k1', 'k2', 'k3'].map(laneOf)))].sort((a, b) => a - b)
    expect({ ...relayed, lanes: [...relayed.lanes].sort((a, b) => a - b) }).toEqual({ lanes, published: 5 })
    expect(publisher.batches).toHaveLength(1)
    expect(publisher.rows.map((row) => Number(row.id))).toEqual([...publisher.rows.map((row) => Number(row.id))].sort((a, b) => a - b))
    expect(await unpublished()).toBe(0)
    expect(await once(publisher)).toBeNull()
  })

  it('leaves a lane another relay holds and takes the others', async () => {
    const keys = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8']
    await addEvents(keys)
    const lanes = new Set(await Promise.all(keys.map(laneOf)))
    expect(lanes.size).toBeGreaterThan(1)
    const holder = await checkout(app)
    const other = await checkout(app)
    try {
      const [first] = [...lanes]
      await holder.client.query('SELECT pg_advisory_lock($1, $2)', [RELAY_DEFAULTS.lockClass, first])
      const publisher = new Recorder()
      let relayed
      while ((relayed = await relayOnce(other.client, publisher))) expect(relayed.lanes).not.toContain(first)
      expect(publisher.rows.some((row) => keys.includes(row.key))).toBe(true)
      expect(await unpublished()).toBe((await app.query('SELECT 1 FROM outbox WHERE lane = $1', [first])).rowCount)
    } finally {
      holder.release(true)
      other.release()
    }
  })

  it('publishes the same batch again when the relay dies between producing and marking', async () => {
    await addEvents(['crash', 'crash'])
    const doomed = await checkout(app)
    const publisher: Publisher = {
      publish: async () => {
        await doomed.client.query('SELECT pg_terminate_backend(pg_backend_pid())').catch(() => undefined)
      },
    }
    await expect(relayOnce(doomed.client, publisher)).rejects.toThrow()
    doomed.release(true)
    expect(await unpublished()).toBe(2)
    const recorder = new Recorder()
    expect(await once(recorder)).toMatchObject({ published: 2 })
    expect(await unpublished()).toBe(0)
  })

  it('marks nothing and lets the lane go when the broker refuses the batch', async () => {
    await addEvents(['down'])
    const publisher = new Recorder()
    publisher.failNext = true
    const lease = await checkout(app)
    try {
      await expect(relayOnce(lease.client, publisher)).rejects.toThrow('broker unavailable')
      const { rows } = await lease.client.query<{ held: number }>(
        "SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
      )
      expect(rows).toEqual([{ held: 0 }])
    } finally {
      lease.release()
    }
    expect(await unpublished()).toBe(1)
    expect(await once(publisher)).toMatchObject({ published: 1 })
  })
})

describe('Relay', () => {
  it('only waits its poll interval when no lane has work, so a steady stream never queues up', async () => {
    const relay = new Relay(app, new Recorder(), { workers: 1, batch: 500, pollMs: 200 })
    relay.start()
    try {
      for (let n = 0; n < 100; n++) {
        await commit([{ topic: 'payments', key: `stream-${n}`, type: 'test.stream', payload: { n } }])
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const deadline = Date.now() + 10_000
      while ((await unpublished()) > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      await relay.stop()
    }
    const { worst } = firstRow(
      await app.query<{ worst: number }>(
        `SELECT max(extract(epoch FROM published_at - created_at) * 1000)::float8 AS worst FROM outbox WHERE type = 'test.stream'`,
      ),
    )
    expect(worst).toBeLessThan(400)
  })

  it('keeps each key in order while several relays and writers run at once', async () => {
    const keys = Array.from({ length: 40 }, (_, i) => `order-${i}`)
    const publisher = new Recorder()
    const relay = new Relay(app, publisher, { workers: 4, batch: 25, pollMs: 5 })
    relay.start()
    try {
      await Promise.all(
        keys.map(async (key) => {
          for (let n = 0; n < 15; n++) await commit([{ topic: 'payments', key, type: 'test.step', payload: { n } }])
        }),
      )
      const deadline = Date.now() + 20_000
      while ((await unpublished()) > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      await relay.stop()
    }
    expect(await unpublished()).toBe(0)
    const seen = new Map<string, number[]>()
    for (const row of publisher.rows) seen.set(row.key, [...(seen.get(row.key) ?? []), (row.payload as { n: number }).n])
    for (const key of keys) expect(seen.get(key)).toEqual(Array.from({ length: 15 }, (_, n) => n))
    expect(relay.published).toBe(keys.length * 15)
  })
})
