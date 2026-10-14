import { execFile } from 'node:child_process'
import { createPublicKey, verify } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkpointBody, fromHex, verifyInclusion } from '@carwash/audit'
import { checkAudit, checkAuditIn, readWitness, violations, type WitnessView } from '@carwash/invariants'
import { createWitnessServer, Witness } from '@carwash/witness'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sequenceBatch } from '@carwash/audit-pg'
import { Sequencer } from '../src/audit/sequencer.service.ts'
import { Database } from '../src/db/database.ts'
import { startStack, type Stack } from './support.ts'

let stack: Stack
let dir: string
let server: Server
let witnessUrl: string
let sequencer: Sequencer
let stateFile: string

const VERIFY = fileURLToPath(new URL('../src/cli/verify.ts', import.meta.url))

function runVerify(args: string[]): Promise<{ code: number; report: any }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--conditions=source', VERIFY, ...args],
      { env: { ...process.env, DATABASE_URL: stack.ledgerDb.url('ledger_audit'), WITNESS_URL: witnessUrl } },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
        if (code !== 0 && code !== 1) return reject(new Error(`verify exited with ${code}: ${stderr}`))
        resolve({ code, report: JSON.parse(stdout) })
      },
    )
  })
}

function pay(amount: number) {
  return { amount, currency: 'EUR', merchant: 'wash_1', token: 'tok_ok' }
}

async function rewriteHistory(client: pg.ClientBase): Promise<void> {
  await client.query('SET LOCAL session_replication_role = replica')
  const { rows } = await client.query<{ journal_id: string }>(
    `SELECT a.journal_id::text FROM audit_log a JOIN journals j ON j.id = a.journal_id WHERE j.external_ref LIKE 'capture:%' ORDER BY a.seq LIMIT 1`,
  )
  const journal = rows[0]!.journal_id
  await client.query(
    `UPDATE entries SET amount = amount + CASE WHEN amount > 0 THEN 100 ELSE -100 END
     WHERE id IN ((SELECT id FROM entries WHERE journal_id = $1 AND amount > 0 ORDER BY id LIMIT 1)
                  UNION ALL (SELECT id FROM entries WHERE journal_id = $1 AND amount < 0 ORDER BY id LIMIT 1))`,
    [journal],
  )
  await client.query('DELETE FROM audit_nodes')
  await client.query('DELETE FROM audit_log')
  await client.query('INSERT INTO audit_queue (journal_id) SELECT id FROM journals ON CONFLICT DO NOTHING')
  while ((await sequenceBatch(client, 1000)) > 0);
}

async function inRollback<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await stack.admin.connect()
  try {
    await client.query('BEGIN')
    return await work(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

beforeAll(async () => {
  stack = await startStack()
  dir = mkdtempSync(join(tmpdir(), 'witness-'))
  server = createWitnessServer(new Witness(dir, 'carwash-ledger'), 'witness-token')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  witnessUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  stateFile = join(dir, 'verifier.json')
  sequencer = new Sequencer(stack.app.get(Database), { ...stack.config, witnessUrl, witnessToken: 'witness-token' })
})

afterAll(async () => {
  await stack?.close()
  server?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('checkpoints and the witness', () => {
  it('has the witness sign each new tree size after a consistency proof, and serves a proof that checks against the signed root', async () => {
    for (const amount of [900, 1500]) await stack.call('POST', '/v1/payments', { body: pay(amount) })
    await sequencer.drain()
    const first = await sequencer.checkpoint()
    expect(first).toMatchObject({ kind: 'signed', fresh: true })
    expect(await sequencer.checkpoint()).toMatchObject({ kind: 'signed', fresh: false })

    for (const amount of [2400, 3500, 4900]) await stack.call('POST', '/v1/payments', { body: pay(amount) })
    await sequencer.drain()
    const second = await sequencer.checkpoint()
    expect(second).toMatchObject({ kind: 'signed', fresh: true })
    if (first?.kind !== 'signed' || second?.kind !== 'signed') throw new Error('unreachable')
    expect(second.size).toBeGreaterThan(first.size)

    const witness = await readWitness(witnessUrl)
    expect(witness.checkpoints.map((c) => c.size)).toEqual([first.size, second.size])
    const { rows } = await stack.admin.query<{ size: string }>('SELECT size::text FROM audit_checkpoints ORDER BY size')
    expect(rows.map((r) => Number(r.size))).toEqual([first.size, second.size])

    expect((await stack.call('GET', '/v1/audit/checkpoints')).body.data.map((c: { tree_size: number }) => c.tree_size)).toEqual([second.size, first.size])
    const checkpoint = (await stack.call('GET', '/v1/audit/checkpoint')).body
    expect(checkpoint).toMatchObject({ tree_size: second.size, witness_key: witness.publicKey })
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: checkpoint.witness_key }, format: 'jwk' })
    const body = checkpointBody({ size: checkpoint.tree_size, root: checkpoint.root }, checkpoint.origin)
    expect(verify(null, Buffer.from(body), key, Buffer.from(checkpoint.signature, 'base64'))).toBe(true)
    const { rows: journals } = await stack.admin.query<{ id: string }>('SELECT journal_id::text AS id FROM audit_log ORDER BY seq LIMIT 1')
    const proof = (await stack.call('GET', `/v1/journals/${journals[0]!.id}/proof?tree_size=${checkpoint.tree_size}`)).body
    expect(proof.root).toBe(checkpoint.root)
    expect(verifyInclusion(fromHex(proof.leaf), proof.seq, proof.tree_size, proof.proof.map(fromHex), fromHex(checkpoint.root))).toBe(true)

    expect(violations([await checkAudit(stack.admin, witness)])).toEqual([])

    const full = await runVerify(['--state', stateFile])
    expect(full).toMatchObject({ code: 0, report: { mode: 'full', size: second.size, witnessed: 2, findings: 0 } })
    expect(existsSync(stateFile)).toBe(true)
    expect(await runVerify(['--state', stateFile])).toMatchObject({ code: 0, report: { mode: 'incremental', from: second.size, journals: 0, findings: 0 } })
  })

  it('catches a history whose hashes were all rewritten to match only through the witness, and the witness refuses to go on', async () => {
    const witness = await readWitness(witnessUrl)
    const signed = witness.checkpoints.map((c) => c.size)
    const [alone, witnessed] = await inRollback(async (client) => {
      await rewriteHistory(client)
      return [await checkAuditIn(client), await checkAuditIn(client, witness)]
    })
    expect(alone.count).toBe(0)
    expect(witnessed.count).toBe(signed.length)
    expect(witnessed.examples.every((e) => /^the root at size \d+ is [0-9a-f]{64}, the witness signed [0-9a-f]{64}$/.test(e))).toBe(true)

    const forged: WitnessView = { ...witness, checkpoints: witness.checkpoints.map((c) => ({ ...c, root: c.root.replace(/^./, (d) => (d === '0' ? '1' : '0')) })) }
    expect((await checkAudit(stack.admin, forged)).examples).toEqual(signed.map((size) => `the checkpoint at size ${size} does not carry the witness's signature`))

    const client = await stack.admin.connect()
    try {
      await client.query('BEGIN')
      await rewriteHistory(client)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const incremental = await runVerify(['--state', stateFile])
    expect(incremental.code).toBe(1)
    expect(incremental.report.examples).toContainEqual({ kind: 'history', size: signed.at(-1), what: 'chain' })
    const full = await runVerify(['--full'])
    expect(full.code).toBe(1)
    expect(full.report.examples.every((f: { kind: string }) => f.kind === 'root')).toBe(true)
    expect((await sequencer.checkpoint())?.kind).toBe('refused')
    await stack.call('POST', '/v1/payments', { body: pay(1200) })
    await sequencer.drain()
    expect(await sequencer.checkpoint()).toMatchObject({ kind: 'refused', code: 'inconsistent' })
    expect((await readWitness(witnessUrl)).checkpoints.map((c) => c.size)).toEqual(signed)

    await stack.admin.query('DELETE FROM audit_nodes WHERE level = 0 AND idx >= $1', [signed.at(-1)! - 1])
    await stack.admin.query('DELETE FROM audit_log WHERE seq >= $1', [signed.at(-1)! - 1])
    expect(await sequencer.checkpoint()).toMatchObject({ kind: 'behind', witnessed: signed.at(-1) })
    expect((await checkAudit(stack.admin, await readWitness(witnessUrl))).examples).toContain(
      `the witness signed size ${signed.at(-1)} but the log has only ${signed.at(-1)! - 1} leaves`,
    )
  })
})
