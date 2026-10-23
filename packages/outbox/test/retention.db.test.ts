import { createTestDatabase, type TestDatabase } from '@carwash/testkit'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pruneInbox, pruneOutbox } from '../src/index.ts'

let db: TestDatabase
let app: pg.Pool
let owner: pg.Pool

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  db = await createTestDatabase()
  cleanup.defer(() => db.drop())
  app = db.pool('ledger_app', 2)
  owner = db.pool('ledger_owner', 2)
})

afterAll(() => cleanup.disposeAsync())

describe('retention', () => {
  it('deletes events published before the window, batch by batch, and keeps recent and unpublished ones', async () => {
    await owner.query(
      `INSERT INTO outbox (topic, key, lane, type, payload, published_at)
       SELECT 'payments', 'k' || n, 0, 'test.event', '{}', CASE WHEN n <= 5 THEN now() - interval '3 hours' WHEN n <= 7 THEN now() END
       FROM generate_series(1, 9) AS n`,
    )
    expect(await pruneOutbox(app, 2, 2)).toBe(5)
    expect((await app.query<{ key: string }>('SELECT key FROM outbox ORDER BY id')).rows.map((row) => row.key)).toEqual(['k6', 'k7', 'k8', 'k9'])
  })

  it('deletes inbox entries received before the window, batch by batch', async () => {
    await owner.query(
      `INSERT INTO inbox (consumer, event_id, received_at)
       SELECT 'receipts', uuidv7(), now() - make_interval(days => 2 * n) FROM generate_series(0, 6) AS n`,
    )
    expect(await pruneInbox(app, 3, 2)).toBe(5)
    expect((await app.query<{ n: number }>('SELECT count(*)::int AS n FROM inbox')).rows).toEqual([{ n: 2 }])
  })
})
