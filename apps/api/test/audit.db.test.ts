import { canonicalJournal, fromHex, leafHash, rootFromLeaves, toHex, verifyConsistency, verifyInclusion } from '@carwash/audit'
import { AuditHeadView, ConsistencyProofView, InclusionProofView, JournalView, LeafView } from '@carwash/contracts'
import { checkAudit, checkAuditIn, checkSequenced, violations } from '@carwash/invariants'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { sequenceBatch } from '@carwash/audit-pg'
import { firstRow, type Transaction } from '@carwash/pg'
import { inRollbackWithTriggersOff } from '@carwash/testkit'
import { Database } from '../src/db/database.ts'
import { startStack, type Stack } from './support.ts'

let stack: Stack

function pay(amount: number) {
  return { amount, currency: 'EUR', merchant: 'wash_1', token: 'tok_ok' }
}

async function sequenceAll(): Promise<number> {
  const db = stack.app.get(Database)
  let total = 0
  for (;;) {
    const n = await db.transaction((client) => sequenceBatch(client, 7))
    total += n
    if (n === 0) return total
  }
}

function s7(corrupt: (client: Transaction) => Promise<unknown>): Promise<string[]> {
  return inRollbackWithTriggersOff(stack.admin, async (client) => {
    await corrupt(client)
    return (await checkAuditIn(client)).examples
  })
}

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  stack = await startStack()
  cleanup.defer(() => stack.close())
})

afterAll(() => cleanup.disposeAsync())

describe('the audit log', () => {
  it('sequences every journal, and proves inclusion and consistency that the audit package accepts', async () => {
    for (const amount of [900, 1500, 2400]) await stack.call('POST', '/v1/payments', { body: pay(amount) })
    expect((await checkSequenced(stack.admin)).count).toBeGreaterThan(0)
    expect(await sequenceAll()).toBeGreaterThan(0)
    expect(violations([await checkAudit(stack.admin), await checkSequenced(stack.admin)])).toEqual([])

    const first = AuditHeadView.parse((await stack.call('GET', '/v1/audit/head')).body)
    const { rows: leaves } = await stack.admin.query<{ leaf: Buffer }>('SELECT leaf FROM audit_log ORDER BY seq')
    expect(first.tree_size).toBe(leaves.length)
    expect(first.root).toBe(toHex(rootFromLeaves(leaves.map((l) => new Uint8Array(l.leaf)))))

    const { rows: journals } = await stack.admin.query<{ id: string }>(`SELECT id::text FROM journals WHERE external_ref LIKE 'capture:%' ORDER BY id`)
    for (const { id } of journals) {
      const proof = InclusionProofView.parse((await stack.call('GET', `/v1/journals/${id}/proof`)).body)
      expect(proof.root).toBe(first.root)
      expect(verifyInclusion(fromHex(proof.leaf), proof.seq, proof.tree_size, proof.proof.map(fromHex), fromHex(proof.root))).toBe(true)
    }

    for (const amount of [3500, 4900, 1500, 900]) await stack.call('POST', '/v1/payments', { body: pay(amount) })
    await sequenceAll()
    const second = AuditHeadView.parse((await stack.call('GET', '/v1/audit/head')).body)
    expect(second.tree_size).toBeGreaterThan(first.tree_size)
    const consistency = ConsistencyProofView.parse((await stack.call('GET', `/v1/audit/consistency?first=${first.tree_size}&second=${second.tree_size}`)).body)
    expect(consistency.first_root).toBe(first.root)
    expect(verifyConsistency(first.tree_size, second.tree_size, fromHex(first.root), fromHex(second.root), consistency.proof.map(fromHex))).toBe(true)
    const [oldest] = journals
    assert(oldest)
    const old = InclusionProofView.parse((await stack.call('GET', `/v1/journals/${oldest.id}/proof?tree_size=${first.tree_size}`)).body)
    expect(old.root).toBe(first.root)
    expect((await stack.call('GET', `/v1/journals/${oldest.id}/proof?tree_size=0`)).status).toBe(400)
  })

  it('catches a changed amount, a rewritten leaf, a deleted journal, a missing record and a forged subtree (S7)', async () => {
    await sequenceAll()
    expect(await s7(async () => undefined)).toEqual([])
    const { journal_id: journal, seq } = firstRow(
      await stack.admin.query<{ journal_id: string; seq: string }>(
        `SELECT a.journal_id::text, a.seq::text FROM audit_log a JOIN journals j ON j.id = a.journal_id WHERE j.external_ref LIKE 'capture:%' ORDER BY a.seq LIMIT 1`,
      ),
    )
    const changed = await s7((c) =>
      c.query(
        `UPDATE entries SET amount = amount + CASE WHEN amount > 0 THEN 1 ELSE -1 END
         WHERE id IN (SELECT id FROM entries WHERE journal_id = $1 ORDER BY id LIMIT 1)`,
        [journal],
      ),
    )
    expect(changed).toEqual([`seq ${seq} (journal ${journal}) does not match its journal`])
    const rewritten = await s7((c) => c.query(`UPDATE audit_log SET leaf = sha256(leaf) WHERE seq = $1`, [seq]))
    expect(rewritten).toEqual(
      expect.arrayContaining([
        `seq ${seq} (journal ${journal}) does not match its journal`,
        `seq ${seq} does not chain from the one before it`,
        `subtree 0:${seq} does not hash its leaf`,
      ]),
    )
    const deleted = await s7(async (c) => {
      await c.query('DELETE FROM entries WHERE journal_id = $1', [journal])
      await c.query('DELETE FROM journals WHERE id = $1', [journal])
    })
    expect(deleted).toEqual([`seq ${seq} (journal ${journal}) has no journal any more`])
    const unrecorded = await s7((c) => c.query('DELETE FROM audit_log WHERE seq = (SELECT max(seq) FROM audit_log)'))
    expect(unrecorded.some((d) => d.endsWith('is neither sequenced nor queued'))).toBe(true)
    const forged = await s7((c) => c.query(`UPDATE audit_nodes SET hash = sha256(hash) WHERE level = 1 AND idx = 0`))
    expect([...forged].sort()).toEqual(['subtree 1:0 does not hash its children', 'subtree 2:0 does not hash its children'])
  })

  it('gives anyone with a key the rows of a journal, from which the leaf the log holds can be computed again', async () => {
    await sequenceAll()
    const { rows } = await stack.admin.query<{ journal_id: string; seq: string; leaf: Buffer }>(
      'SELECT a.journal_id::text, a.seq::text, a.leaf FROM audit_log a ORDER BY a.seq DESC LIMIT 3',
    )
    for (const row of rows) {
      const journal = JournalView.parse((await stack.call('GET', `/v1/journals/${row.journal_id}`)).body)
      expect(journal).toMatchObject({ object: 'journal', id: row.journal_id, seq: Number(row.seq) })
      const leaf = leafHash(
        canonicalJournal({
          id: BigInt(journal.id),
          externalRef: journal.external_ref,
          createdAtMicros: BigInt(journal.created_at_micros),
          entries: journal.entries.map((e: { id: string; account_id: string; amount: string }) => ({
            id: BigInt(e.id),
            accountId: BigInt(e.account_id),
            amount: BigInt(e.amount),
          })),
        }),
      )
      expect(toHex(leaf)).toBe(toHex(new Uint8Array(row.leaf)))
    }
    const [newest] = rows
    assert(newest)
    const top = LeafView.parse((await stack.call('GET', `/v1/audit/leaves/${newest.seq}`)).body)
    expect(top).toEqual({ object: 'leaf', seq: Number(newest.seq), journal_id: newest.journal_id, leaf: toHex(new Uint8Array(newest.leaf)) })
    expect((await stack.call('GET', '/v1/audit/leaves/999999')).status).toBe(404)
    expect((await stack.call('GET', '/v1/journals/999999999')).status).toBe(404)
    expect((await stack.call('GET', '/v1/journals/1', { as: 'nobody' })).status).toBe(401)
  })

  it('reports a journal still waiting to be sequenced (L4)', async () => {
    await stack.call('POST', '/v1/payments', { body: pay(2400) })
    expect((await checkSequenced(stack.admin)).count).toBeGreaterThan(0)
    await sequenceAll()
    expect((await checkSequenced(stack.admin)).count).toBe(0)
  })

  it('refuses a sequence number, journal id or tree size that is not a whole number', async () => {
    const refused = async (path: string) => (await stack.call('GET', path)).body
    const message = (text: string) => ({ error: { code: 'invalid_request', message: text } })
    expect(await refused('/v1/audit/leaves/one')).toEqual(message('seq must be a tree size'))
    expect(await refused('/v1/journals/12abc')).toEqual(message('the journal id must be a number'))
    expect(await refused('/v1/journals/1/proof?tree_size=0x10')).toEqual(message('tree_size must be a tree size'))
    expect(await refused('/v1/audit/consistency')).toEqual(message('first must be a tree size'))
    expect(await refused('/v1/audit/consistency?first=1&second=2.0')).toEqual(message('second must be a tree size'))
  })
})
