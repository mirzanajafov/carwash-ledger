import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toHex } from '@carwash/audit'
import { AccountRegistry, PgCtePoster, pgAccountLoader } from '@carwash/ledger'
import { createTestDatabase, signCopies, type SignedCopies, type TestDatabase } from '@carwash/testkit'
import { createWitnessServer, Witness } from '@carwash/witness'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Checkpointer,
  head,
  restore,
  rootAt,
  sequenceBatch,
  tamper,
  verifyLog,
  WitnessClient,
  type TamperClass,
  type VerifierState,
  type WitnessAnchor,
} from '../src/index.ts'

let db: TestDatabase
let app: pg.Pool
let admin: pg.Pool
let poster: PgCtePoster
let accounts: bigint[]
let dir: string
let server: Server
let witnessed: WitnessAnchor
let witness: Witness
let checkpointer: Checkpointer
let posted = 0

async function post(count: number): Promise<void> {
  for (let i = 0; i < count; i++, posted++) {
    const amount = 500 + ((posted * 37) % 4000)
    const fee = Math.floor(amount / 40)
    await poster.post({
      externalRef: `capture:${posted}`,
      entries: [
        { accountId: accounts[0]!, amount: BigInt(amount) },
        { accountId: accounts[1]!, amount: BigInt(-(amount - fee)) },
        { accountId: accounts[2]!, amount: BigInt(-fee) },
      ],
    })
  }
  const client = await app.connect()
  try {
    for (;;) {
      await client.query('BEGIN')
      const sequenced = await sequenceBatch(client, 7)
      await client.query('COMMIT')
      if (sequenced === 0) break
    }
  } finally {
    client.release()
  }
}

function anchor(): WitnessAnchor {
  return { origin: witness.origin, publicKey: witness.publicKey, latest: witness.latest() }
}

async function inRollback<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await admin.connect()
  try {
    await client.query('BEGIN')
    return await work(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

function tampered(tamperClass: TamperClass, seq: number, options: { witness?: boolean; from?: VerifierState } = {}) {
  return inRollback(async (client) => {
    const what = await tamper(client, tamperClass, seq)
    return { what, report: await verifyLog(client, { witness: options.witness === false ? undefined : witnessed, from: options.from, batch: 6 }) }
  })
}

beforeAll(async () => {
  db = await createTestDatabase()
  app = db.pool('ledger_app', 4)
  admin = db.pool('admin', 2)
  accounts = []
  for (const [code, type] of [
    ['receivable', 'asset'],
    ['merchant', 'liability'],
    ['fees', 'revenue'],
  ] as const) {
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO accounts (code, type, currency, balance_mode, shards) VALUES ($1, $2::account_type, 'EUR', 'derived', 1) RETURNING id::text`,
      [code, type],
    )
    accounts.push(BigInt(rows[0]!.id))
  }
  poster = new PgCtePoster(app, new AccountRegistry(pgAccountLoader(app)))
  dir = mkdtempSync(join(tmpdir(), 'witness-'))
  witness = new Witness(dir, 'carwash-ledger')
  server = createWitnessServer(witness, 'token')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  checkpointer = new Checkpointer(app, new WitnessClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'token', 2000))
  await post(16)
  expect(await checkpointer.run()).toMatchObject({ kind: 'signed', size: 16 })
  await post(17)
  expect(await checkpointer.run()).toMatchObject({ kind: 'signed', size: 33 })
  await post(7)
  witnessed = anchor()
})

afterAll(async () => {
  server?.close()
  await db?.drop()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('full verification', () => {
  it('sequences queued journals in the order of their ids, not the order of their ids as text', async () => {
    const { rows } = await admin.query<{ id: string }>('SELECT a.journal_id::text AS id FROM audit_log a ORDER BY a.seq')
    const ids = rows.map((r) => BigInt(r.id))
    expect(ids.length).toBe(40)
    expect(ids.every((id, i) => i === 0 || id > ids[i - 1]!)).toBe(true)
  })

  it('finds nothing in an honest log, compares every signed root and ends where the log ends', async () => {
    const report = await verifyLog(app, { witness: witnessed, batch: 6 })
    expect(report).toMatchObject({ mode: 'full', from: 0, size: 40, journals: 40, witnessed: 2, findings: 0, firstSeq: null })
    expect(report.state).toMatchObject({ size: 40, root: toHex((await head(app)).root), chain: toHex((await head(app)).chain) })
  })

  it('reports how far it got after every batch, ending at the size of the log', async () => {
    const progress: [number, number][] = []
    await verifyLog(app, {
      batch: 16,
      onProgress: async (done, size) => {
        progress.push([done, size])
      },
    })
    expect(progress).toEqual([
      [16, 40],
      [32, 40],
      [40, 40],
    ])
  })

  it('names the journal whose entries changed (class 1), with or without the witness', async () => {
    const { what, report } = await tampered(1, 20)
    expect(report.firstSeq).toBe(20)
    expect(report.examples).toContainEqual({ kind: 'leaf', seq: 20, journalId: what.journalId })
    expect(report.examples).toContainEqual({ kind: 'root', size: 33, after: 16 })
    const alone = await tampered(1, 20, { witness: false })
    expect(alone.report.examples).toEqual([{ kind: 'leaf', seq: 20, journalId: alone.what.journalId }])
  })

  it('sees a history rewritten to agree with itself (class 2) only through the witness, between the signed sizes around it', async () => {
    const { report } = await tampered(2, 20)
    expect(report.examples).toEqual([{ kind: 'root', size: 33, after: 16 }])
    expect(report.firstSeq).toBe(16)
    expect((await tampered(2, 3)).report.examples).toEqual([
      { kind: 'root', size: 16, after: 0 },
      { kind: 'root', size: 33, after: 0 },
    ])
    expect((await tampered(2, 20, { witness: false })).report.findings).toBe(0)
    expect((await tampered(2, 36)).report.findings).toBe(0)
  })

  it('names a deleted journal (class 3), whose leaf still matches every signed root', async () => {
    const { what, report } = await tampered(3, 5)
    expect(report.examples).toEqual([{ kind: 'missing_journal', seq: 5, journalId: what.journalId }])
  })

  it('reports a dropped log record as a gap, a signature it cannot check, and a journal nobody sequenced', async () => {
    const gap = await inRollback(async (client) => {
      await client.query('DELETE FROM audit_log WHERE seq = 10')
      return verifyLog(client, { witness: witnessed })
    })
    expect(gap.examples).toContainEqual({ kind: 'gap', seq: 10, missing: 1 })
    expect(gap.state).toBeNull()

    const forged = await inRollback(async (client) => {
      await client.query('UPDATE audit_checkpoints SET size = 17 WHERE size = 16')
      return verifyLog(client, { witness: witnessed })
    })
    expect(forged.examples).toEqual([{ kind: 'signature', size: 17 }])

    const last = await inRollback(async (client) => {
      const { rows } = await client.query<{ journal_id: string }>('DELETE FROM audit_log WHERE seq = 39 RETURNING journal_id::text')
      return { journalId: rows[0]!.journal_id, report: await verifyLog(client, { witness: witnessed }) }
    })
    expect(last.report.examples).toEqual([{ kind: 'unsequenced', journalId: last.journalId }])
  })
})

describe('signed roots', () => {
  it("compares the copies in audit_checkpoints and the witness's latest checkpoint, each once", async () => {
    const copies = await inRollback(async (client) => {
      await client.query('DELETE FROM audit_checkpoints WHERE size = 33')
      return verifyLog(client, { witness: witnessed })
    })
    expect(copies).toMatchObject({ witnessed: 2, findings: 0 })
    expect((await verifyLog(app, { witness: witnessed })).witnessed).toBe(2)
  })

  it('still catches a rewrite through the latest checkpoint when the copies are gone, in a wider range', async () => {
    const report = await inRollback(async (client) => {
      await tamper(client, 2, 20)
      await client.query('DELETE FROM audit_checkpoints')
      return verifyLog(client, { witness: witnessed })
    })
    expect(report.examples).toEqual([{ kind: 'root', size: 33, after: 0 }])
  })

  it('leaves out copies made under another witness key, as if they had been deleted', async () => {
    const report = await inRollback(async (client) => {
      await client.query(`UPDATE audit_checkpoints SET witness_key = 'another' WHERE size = 16`)
      return verifyLog(client, { witness: witnessed })
    })
    expect(report).toMatchObject({ witnessed: 1, findings: 0 })
  })

  it('never compares a copy rewritten to agree with a rewritten history, because its signature fails', async () => {
    const report = await inRollback(async (client) => {
      await tamper(client, 2, 20)
      await client.query('UPDATE audit_checkpoints SET root = $1 WHERE size = 33', [Buffer.from(await rootAt(client, 33))])
      return verifyLog(client, { witness: witnessed })
    })
    expect(report.examples).toEqual([
      { kind: 'signature', size: 33 },
      { kind: 'root', size: 33, after: 16 },
    ])
  })

  it('reports signed sizes the log no longer reaches, as after a rollback', async () => {
    const report = await inRollback(async (client) => {
      await client.query('DELETE FROM audit_log WHERE seq >= 30')
      return verifyLog(client, { witness: witnessed })
    })
    expect(report.examples).toContainEqual({ kind: 'beyond', size: 33, treeSize: 30 })
    expect(report.examples.filter((f) => f.kind === 'beyond')).toHaveLength(1)
  })
})

describe('restoring a tamper', () => {
  it('puts every class back so that the full verifier and the stored hashes agree with the witness again', async () => {
    const before = await head(app)
    for (const tamperClass of [1, 2, 3] as const) {
      const client = await admin.connect()
      try {
        await client.query('BEGIN')
        const what = await tamper(client, tamperClass, 20)
        expect((await verifyLog(client, { witness: witnessed })).findings).toBeGreaterThan(0)
        await restore(client, what)
        const report = await verifyLog(client, { witness: witnessed })
        expect(report.findings).toBe(0)
        expect(report.state).toMatchObject({ root: toHex(before.root), chain: toHex(before.chain) })
        expect(toHex((await head(client)).root)).toBe(toHex(before.root))
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }
  })
})

describe('incremental verification', () => {
  it('reads only the new journals, picks up the signed roots after its state, and ends where a full run ends', async () => {
    const full = await verifyLog(app, { witness: witnessed })
    await post(30)
    expect(await checkpointer.run()).toMatchObject({ kind: 'signed', size: 70 })
    witnessed = anchor()
    const step = await verifyLog(app, { witness: witnessed, from: full.state!, batch: 6 })
    expect(step).toMatchObject({ mode: 'incremental', from: 40, size: 70, journals: 30, witnessed: 1, findings: 0 })
    expect(step.state).toEqual((await verifyLog(app, { witness: witnessed })).state)
  })

  it('catches a rewrite below its state through the stored chain and root, even where no checkpoint covers it', async () => {
    await post(5)
    const full = await verifyLog(app, { witness: witnessed })
    expect(full.state!.size).toBe(75)
    const { report } = await tampered(2, 72, { from: full.state! })
    expect(report.examples).toEqual(
      expect.arrayContaining([
        { kind: 'history', size: full.state!.size, what: 'chain' },
        { kind: 'history', size: full.state!.size, what: 'root' },
      ]),
    )
    expect((await tampered(2, 72)).report.findings).toBe(0)
  })

  it('does not see an entry edited below its state with the hashes left alone, which is what a full run is for', async () => {
    const full = await verifyLog(app, { witness: witnessed })
    expect((await tampered(1, 20, { from: full.state! })).report.findings).toBe(0)
    expect((await tampered(1, 20)).report.findings).toBeGreaterThan(0)
  })
})

describe('sharing the process', () => {
  const BULK = 10_000
  let client: pg.PoolClient
  let stand: SignedCopies

  async function longestStall(work: () => Promise<unknown>): Promise<{ longest: number; total: number }> {
    let last = performance.now()
    let longest = 0
    const ticker = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 1)
    const started = performance.now()
    try {
      await work()
    } finally {
      clearInterval(ticker)
    }
    longest = Math.max(longest, performance.now() - last)
    return { longest, total: performance.now() - started }
  }

  beforeAll(async () => {
    client = await admin.connect()
    await client.query('BEGIN')
    await client.query(
      `WITH j AS (INSERT INTO journals (external_ref) SELECT 'bulk:' || g FROM generate_series(1, $3::int) g RETURNING id)
       INSERT INTO entries (journal_id, account_id, amount)
       SELECT j.id, x.account_id, x.amount FROM j CROSS JOIN (VALUES ($1::bigint, 700::bigint), ($2::bigint, -700::bigint)) AS x(account_id, amount)`,
      [accounts[0], accounts[1], BULK],
    )
    let sequenced: number
    do {
      sequenced = await sequenceBatch(client, 1000)
    } while (sequenced > 0)
    stand = await signCopies(client, posted + BULK, 1)
  })

  afterAll(async () => {
    await client.query('ROLLBACK')
    client.release()
  })

  it('lets other work run between journals instead of hashing the whole log in one go', async () => {
    const { longest, total } = await longestStall(async () => {
      expect(await verifyLog(client, { batch: 50_000 })).toMatchObject({ journals: posted + BULK, findings: 0 })
    })
    expect(longest).toBeLessThan(total / 3)
  })

  it('lets other work run between signatures too', async () => {
    const { longest, total } = await longestStall(async () => {
      expect(await verifyLog(client, { witness: stand, batch: 50_000 })).toMatchObject({ journals: posted + BULK, witnessed: stand.count, findings: 0 })
    })
    expect(longest).toBeLessThan(total / 3)
  })

  it('stops at its next turn when asked, long before the batch would end', async () => {
    const started = performance.now()
    await verifyLog(client, { witness: stand, batch: 50_000 })
    const whole = performance.now() - started
    const stop = new AbortController()
    const progress: number[] = []
    const asked = performance.now()
    setTimeout(() => {
      stop.abort()
    }, 0)
    await expect(
      verifyLog(client, {
        witness: stand,
        batch: 50_000,
        signal: stop.signal,
        onProgress: async (done) => {
          progress.push(done)
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).toEqual([])
    expect(performance.now() - asked).toBeLessThan(whole / 4)
  })

  it('refuses a batch that would never move', async () => {
    await expect(verifyLog(client, { batch: 0 })).rejects.toThrow(RangeError)
  })
})
