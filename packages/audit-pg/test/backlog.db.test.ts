import { checkAudit, checkSequenced, violations } from '@carwash/invariants'
import { AccountRegistry, createAccount, PgCtePoster, pgAccountLoader } from '@carwash/ledger'
import { applyMigration, createTestDatabase, migrationNames, type TestDatabase } from '@carwash/testkit'
import { afterAll, assert, describe, expect, it } from 'vitest'
import { sequenceBatch } from '../src/index.ts'

const NAMES = migrationNames()
const AUDIT = NAMES.findIndex((name) => name.endsWith('_audit_log'))

let db: TestDatabase | undefined

afterAll(async () => {
  await db?.drop()
})

describe('a ledger that existed before the audit log', () => {
  it('has its old journals queued by a later migration, so that they are sequenced like any other', async () => {
    const through = NAMES[AUDIT - 1]
    assert(through)
    db = await createTestDatabase({ through })
    const app = db.pool('ledger_app', 2)
    const spec = { currency: 'EUR', balanceMode: 'derived' as const, shards: 1 }
    const receivable = await createAccount(app, { ...spec, code: 'receivable', type: 'asset' })
    const merchant = await createAccount(app, { ...spec, code: 'merchant', type: 'liability' })
    const poster = new PgCtePoster(app, new AccountRegistry(pgAccountLoader(app)))
    for (let i = 0; i < 5; i++)
      await poster.post({
        externalRef: `old:${i}`,
        entries: [
          { accountId: receivable.id, amount: 900n },
          { accountId: merchant.id, amount: -900n },
        ],
      })
    for (const name of NAMES.slice(AUDIT)) await applyMigration(db.url('ledger_owner'), name)
    await poster.post({
      externalRef: 'new:0',
      entries: [
        { accountId: receivable.id, amount: 1500n },
        { accountId: merchant.id, amount: -1500n },
      ],
    })
    const audit = db.pool('ledger_audit', 1)
    const { rows } = await audit.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_queue')
    expect(rows).toEqual([{ n: 6 }])
    const client = await app.connect()
    try {
      await client.query('BEGIN')
      expect(await sequenceBatch(client, 100)).toBe(6)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    expect(violations([await checkAudit(audit), await checkSequenced(audit)])).toEqual([])
  })
})
