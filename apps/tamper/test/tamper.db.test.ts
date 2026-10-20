import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Checkpointer, sequenceBatch, verifyLog, WitnessClient, type WitnessedRoots } from '@carwash/audit-pg'
import { AccountRegistry, createAccount, PgCtePoster, pgAccountLoader } from '@carwash/ledger'
import { createTestDatabase, type TestDatabase } from '@carwash/testkit'
import { createWitnessServer, Witness } from '@carwash/witness'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTamperServer, TamperService } from '../src/index.ts'

let db: TestDatabase
let app: pg.Pool
let admin: pg.Pool
let dirs: string[] = []
let servers: Server[] = []
let witness: Witness
let stateDir: string

function roots(): WitnessedRoots {
  return { origin: witness.origin, publicKey: witness.publicKey, checkpoints: witness.history() }
}

async function serve(server: Server): Promise<string> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function client(base: string, token = 'tamper-token') {
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as any }
  }
}

beforeAll(async () => {
  db = await createTestDatabase()
  app = db.pool('ledger_app', 4)
  admin = db.pool('admin', 2)
  const spec = { currency: 'EUR', balanceMode: 'derived' as const, shards: 1 }
  const receivable = await createAccount(app, { ...spec, code: 'receivable', type: 'asset' })
  const merchant = await createAccount(app, { ...spec, code: 'merchant', type: 'liability' })
  const poster = new PgCtePoster(app, new AccountRegistry(pgAccountLoader(app)))
  for (let i = 0; i < 30; i++) {
    await poster.post({
      externalRef: `capture:${i}`,
      entries: [
        { accountId: receivable.id, amount: 1500n },
        { accountId: merchant.id, amount: -1500n },
      ],
    })
  }
  const lease = await app.connect()
  try {
    await lease.query('BEGIN')
    await sequenceBatch(lease, 1000)
    await lease.query('COMMIT')
  } finally {
    lease.release()
  }
  const witnessDir = mkdtempSync(join(tmpdir(), 'witness-'))
  stateDir = mkdtempSync(join(tmpdir(), 'tamper-'))
  dirs = [witnessDir, stateDir]
  witness = new Witness(witnessDir, 'carwash-ledger')
  const witnessUrl = await serve(createWitnessServer(witness, 'w'))
  expect(await new Checkpointer(app, new WitnessClient(witnessUrl, 'w', 2000)).run()).toMatchObject({ kind: 'signed', size: 30 })
})

afterAll(async () => {
  for (const server of servers) server.close()
  await db?.drop()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('the tamper service', () => {
  it('tampers with one witnessed journal at a time, survives a restart, and restores it so that verification is clean again', async () => {
    const call = client(await serve(createTamperServer(new TamperService(admin, stateDir, { random: () => 0.5 }), 'tamper-token')))
    expect((await client(`http://127.0.0.1:${(servers.at(-1)!.address() as AddressInfo).port}`, 'nope')('GET', '/v1/tamper')).status).toBe(401)
    expect(await call('GET', '/v1/tamper')).toEqual({ status: 200, body: { tamper: null } })
    expect((await call('POST', '/v1/tamper', { class: 4 })).status).toBe(400)

    const tampered = await call('POST', '/v1/tamper', { class: 2 })
    expect(tampered).toMatchObject({ status: 201, body: { tamper: { tamper_class: 2, seq: 15, witnessed_size: 30 } } })
    expect((await verifyLog(admin, { witness: roots() })).examples).toEqual([{ kind: 'root', size: 30, after: 0 }])
    expect((await call('POST', '/v1/tamper', { class: 1 })).body.error.code).toBe('already_tampered')

    const restarted = client(await serve(createTamperServer(new TamperService(admin, stateDir), 'tamper-token')))
    expect((await restarted('GET', '/v1/tamper')).body.tamper).toMatchObject({ tamper_class: 2, seq: 15 })
    expect(await restarted('POST', '/v1/restore')).toMatchObject({ status: 200, body: { restored: { tamper_class: 2, seq: 15 } } })
    expect((await verifyLog(admin, { witness: roots() })).findings).toBe(0)
    expect((await restarted('POST', '/v1/restore')).body.error.code).toBe('nothing_to_restore')
  })

  it('answers every oversized body with 413 and tells a broken body from one that is not an object', async () => {
    const call = client(await serve(createTamperServer(new TamperService(admin, stateDir), 'tamper-token')))
    for (let i = 0; i < 10; i++) {
      expect(await call('POST', '/v1/tamper', { class: 1, note: 'x'.repeat(2_000_000) })).toEqual({
        status: 413,
        body: { error: { code: 'too_large', message: 'the body is larger than 10000 bytes' } },
      })
    }
    expect(await call('POST', '/v1/tamper', '{"class": 1')).toEqual({ status: 400, body: { error: { code: 'invalid', message: 'the body is not JSON' } } })
    expect(await call('POST', '/v1/tamper', 'null')).toEqual({ status: 400, body: { error: { code: 'invalid', message: 'the body must be a JSON object' } } })
    expect((await call('GET', '/v1/tamper')).body.tamper).toBeNull()
  })

  it('restores on its own after the configured time, also after a restart', async () => {
    const service = new TamperService(admin, stateDir, { random: () => 0.7, autoRestoreMs: 600 })
    try {
      const tampered = await service.tamper(1)
      expect(tampered.restores_at).not.toBeNull()
      expect((await verifyLog(admin, { witness: roots() })).findings).toBeGreaterThan(0)
      service.close()
      const restarted = new TamperService(admin, stateDir, { autoRestoreMs: 600 })
      try {
        await sleep(1500)
        expect(restarted.current()).toBeNull()
        expect((await verifyLog(admin, { witness: roots() })).findings).toBe(0)
      } finally {
        restarted.close()
      }
    } finally {
      service.close()
    }
  })

  it('puts a deleted journal back with its own ids', async () => {
    const call = client(await serve(createTamperServer(new TamperService(admin, stateDir, { random: () => 0.1 }), 'tamper-token')))
    const before = await admin.query(
      'SELECT j.id, j.created_xid::text, e.id AS entry, e.amount, e.currency FROM journals j JOIN entries e ON e.journal_id = j.id ORDER BY e.id',
    )
    const { body } = await call('POST', '/v1/tamper', { class: 3 })
    expect((await verifyLog(admin, { witness: roots() })).examples).toEqual([{ kind: 'missing_journal', seq: 3, journalId: body.tamper.journal_id }])
    await call('POST', '/v1/restore')
    const after = await admin.query(
      'SELECT j.id, j.created_xid::text, e.id AS entry, e.amount, e.currency FROM journals j JOIN entries e ON e.journal_id = j.id ORDER BY e.id',
    )
    expect(after.rows).toEqual(before.rows)
    expect((await verifyLog(admin, { witness: roots() })).findings).toBe(0)
  })
})
