import { setTimeout as sleep } from 'node:timers/promises'
import { firstRow } from '@carwash/pg'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createScratchDatabase } from '../src/index.ts'

describe('a scratch database', () => {
  it("keeps a pool working when an idle client's backend is terminated, the way a forced drop does", async () => {
    const db = await createScratchDatabase('kit')
    onTestFinished(() => db.drop())
    const pool = db.pool(1)
    const { pid } = firstRow(await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))

    await db.pool(1).query('SELECT pg_terminate_backend($1)', [pid])
    for (let i = 0; i < 100 && pool.totalCount > 0; i++) await sleep(20)

    expect(pool.totalCount).toBe(0)
    expect(firstRow(await pool.query<{ ok: number }>('SELECT 1 AS ok')).ok).toBe(1)
  })

  it('ends the pools it handed out when it drops the database, one already ended included', async () => {
    const db = await createScratchDatabase('kit')
    const pool = db.pool()
    const ended = db.pool()
    await pool.query('SELECT 1')
    await ended.end()

    await db.drop()

    expect([pool.ended, ended.ended]).toEqual([true, true])
  })
})
