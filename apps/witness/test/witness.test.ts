import { createPublicKey, verify } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, describe, expect, it } from 'vitest'
import { checkpointBody, completedBy, consistencyProof, leafHash, rootOf, toHex, type Hash, type SubtreeSource } from '@carwash/audit'
import { WitnessCheckpointView } from '@carwash/contracts'
import { createWitnessServer, Refusal, Witness } from '../src/index.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'witness-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function log(seed: number, size: number): SubtreeSource {
  const nodes = new Map<string, Hash>()
  const source = (level: number, index: number) => {
    const hash = nodes.get(`${level}:${index}`)
    if (!hash) throw new Error(`no subtree ${level}:${index}`)
    return hash
  }
  for (let i = 0; i < size; i++) {
    const leaf = leafHash(Uint8Array.of(seed, i & 0xff, (i >> 8) & 0xff))
    for (const node of completedBy(i, leaf, source)) nodes.set(`${node.level}:${node.index}`, node.hash)
  }
  return source
}

function submission(source: SubtreeSource, size: number, fromSize = 0) {
  return {
    size,
    root: toHex(rootOf(size, source)),
    from_size: fromSize,
    proof: fromSize > 0 ? consistencyProof(fromSize, size, source).map(toHex) : [],
  }
}

async function signedHistory(witness: Witness): Promise<WitnessCheckpointView[]> {
  const signed: WitnessCheckpointView[] = []
  for await (const line of witness.history()) signed.push(WitnessCheckpointView.parse(JSON.parse(line)))
  return signed
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Refusal) return error.code
    throw error
  }
  throw new Error('the witness signed something it should have refused')
}

describe('the witness', () => {
  it('signs the first checkpoint it sees, and anyone with the published key can check the signature', async () => {
    const source = log(1, 40)
    const witness = new Witness(tempDir(), 'test-log')
    const { signed, fresh } = await witness.submit(submission(source, 17))
    expect(fresh).toBe(true)
    expect(signed).toMatchObject({ size: 17, root: toHex(rootOf(17, source)) })
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: witness.publicKey }, format: 'jwk' })
    const body = Buffer.from(checkpointBody(signed, 'test-log'))
    expect(verify(null, body, key, Buffer.from(signed.signature, 'base64'))).toBe(true)
    expect(verify(null, Buffer.from(checkpointBody(signed, 'another-log')), key, Buffer.from(signed.signature, 'base64'))).toBe(false)
  })

  it('moves forward only with a consistency proof from the size it signed last', async () => {
    const source = log(2, 300)
    const witness = new Witness(tempDir(), 'test-log')
    await witness.submit(submission(source, 5))
    expect(await refusal(witness.submit({ ...submission(source, 90, 5), proof: [] }))).toBe('inconsistent')
    expect(await refusal(witness.submit(submission(source, 90, 4)))).toBe('stale')
    expect((await witness.submit(submission(source, 90, 5))).fresh).toBe(true)
    expect((await witness.submit(submission(source, 256, 90))).fresh).toBe(true)
    expect((await witness.submit(submission(source, 300, 256))).fresh).toBe(true)
    expect((await signedHistory(witness)).map((c) => c.size)).toEqual([5, 90, 256, 300])
  })

  it('refuses a log that was rewritten under a size it already signed, even with a proof that fits the new log', async () => {
    const honest = log(3, 200)
    const rewritten = log(4, 200)
    const witness = new Witness(tempDir(), 'test-log')
    await witness.submit(submission(honest, 120))
    expect(await refusal(witness.submit(submission(rewritten, 120)))).toBe('fork')
    expect(await refusal(witness.submit(submission(rewritten, 200, 120)))).toBe('inconsistent')
    expect(await refusal(witness.submit(submission(honest, 119)))).toBe('rollback')
    const again = await witness.submit(submission(honest, 120))
    expect(again.fresh).toBe(false)
    expect(again.signed).toEqual(witness.latest())
    expect(await signedHistory(witness)).toHaveLength(1)
  })

  it('handles one submission at a time, so two extensions of the same checkpoint cannot both win', async () => {
    const source = log(5, 64)
    const witness = new Witness(tempDir(), 'test-log')
    await witness.submit(submission(source, 10))
    const results = await Promise.allSettled([witness.submit(submission(source, 30, 10)), witness.submit(submission(source, 40, 10))])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    expect(((results[1] as PromiseRejectedResult).reason as Refusal).code).toBe('stale')
  })

  it('keeps its key and history across a restart and refuses to start from a log whose newest line it did not sign', async () => {
    const dir = tempDir()
    const source = log(6, 50)
    const first = new Witness(dir, 'test-log')
    await first.submit(submission(source, 20))
    await first.submit(submission(source, 50, 20))
    if (process.platform !== 'win32') expect(statSync(join(dir, 'witness.key')).mode & 0o777).toBe(0o600)
    const second = new Witness(dir, 'test-log')
    expect(second.publicKey).toBe(first.publicKey)
    expect(second.latest()).toEqual(first.latest())
    expect(await signedHistory(second)).toEqual(await signedHistory(first))
    expect(await refusal(second.submit(submission(source, 49)))).toBe('rollback')
    const lines = readFileSync(join(dir, 'checkpoints.jsonl'), 'utf8').trim().split('\n')
    const [oldest, newest] = lines
    assert(oldest && newest)
    const forged = { ...WitnessCheckpointView.parse(JSON.parse(newest)), root: toHex(rootOf(50, log(7, 50))) }
    writeFileSync(join(dir, 'checkpoints.jsonl'), `${oldest}\n${JSON.stringify(forged)}\n`)
    expect(() => new Witness(dir, 'test-log')).toThrow(/did not sign/)
    writeFileSync(join(dir, 'checkpoints.jsonl'), `${oldest}\n`)
    appendFileSync(join(dir, 'checkpoints.jsonl'), '\n')
    expect(new Witness(dir, 'test-log').latest()?.size).toBe(20)
  })

  it('starts from the newest line alone, so a line changed further back is left to whoever reads the history', async () => {
    const dir = tempDir()
    const source = log(10, 80)
    const witness = new Witness(dir, 'test-log')
    await witness.submit(submission(source, 30))
    await witness.submit(submission(source, 80, 30))
    const [older, newest] = await signedHistory(witness)
    writeFileSync(join(dir, 'checkpoints.jsonl'), `${JSON.stringify({ ...older, root: toHex(rootOf(30, log(11, 30))) })}\n${JSON.stringify(newest)}\n`)
    const restarted = new Witness(dir, 'test-log')
    expect(restarted.latest()).toEqual(witness.latest())
    expect((await signedHistory(restarted)).map((signed) => restarted.verify(signed))).toEqual([false, true])
  })

  it('finds the newest line when it is longer than one read from the end of a long log', async () => {
    const dir = tempDir()
    const source = log(12, 200)
    const witness = new Witness(dir, 'test-log')
    for (let size = 10; size <= 200; size += 10) await witness.submit(submission(source, size, size === 10 ? 0 : size - 10))
    const newest = { ...witness.latest(), signed_at: 'x'.repeat(10_000) }
    appendFileSync(join(dir, 'checkpoints.jsonl'), `${JSON.stringify(newest)}\n\n`)
    expect(statSync(join(dir, 'checkpoints.jsonl')).size).toBeGreaterThan(14_000)
    expect(new Witness(dir, 'test-log').latest()).toEqual(newest)
    appendFileSync(join(dir, 'checkpoints.jsonl'), 'x'.repeat(70_000))
    expect(() => new Witness(dir, 'test-log')).toThrow(/longer than 65536 bytes/)
  })
})

async function serve(witness: Witness) {
  const server = createWitnessServer(witness, 'secret-token')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (body: unknown, token = 'secret-token') =>
    fetch(`${base}/v1/checkpoints`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  return { server, base, post }
}

describe('the witness server', () => {
  it('serves the key and checkpoints to anyone and takes submissions only with the token', async () => {
    const source = log(8, 100)
    const witness = new Witness(tempDir(), 'test-log')
    const { server, base, post } = await serve(witness)
    try {
      expect(await (await fetch(`${base}/v1/key`)).json()).toEqual({ origin: 'test-log', algorithm: 'ed25519', public_key: witness.publicKey })
      expect((await fetch(`${base}/v1/checkpoints/latest`)).status).toBe(404)
      expect(await (await fetch(`${base}/v1/checkpoints`)).json()).toEqual({ data: [] })
      expect((await post(submission(source, 10), 'wrong-token-1')).status).toBe(401)
      expect((await post(submission(source, 10), 'secret-token-but-longer')).status).toBe(401)
      expect((await post('{"size":')).status).toBe(400)
      expect((await post({ size: 0, root: toHex(rootOf(1, source)) })).status).toBe(400)
      expect((await post({ size: 10, root: 'ZZ' })).status).toBe(400)
      expect((await post({ ...submission(source, 10), proof: Array(65).fill(toHex(rootOf(1, source))) })).status).toBe(400)
      expect((await post(submission(source, 10))).status).toBe(201)
      expect((await post(submission(source, 10))).status).toBe(200)
      const fork = await post(submission(log(9, 10), 10))
      expect(fork.status).toBe(409)
      expect(await fork.json()).toMatchObject({ error: { code: 'fork' } })
      expect((await post(submission(source, 60, 10))).status).toBe(201)
      expect(await (await fetch(`${base}/v1/checkpoints/latest`)).json()).toMatchObject({ size: 60, root: toHex(rootOf(60, source)) })
      expect(await (await fetch(`${base}/v1/checkpoints`)).json()).toMatchObject({ data: [{ size: 10 }, { size: 60 }] })
    } finally {
      server.close()
    }
  })

  it('answers every submission over 1 MB with 413 and signs none of them', async () => {
    const witness = new Witness(tempDir(), 'test-log')
    const { server, post } = await serve(witness)
    try {
      for (let i = 0; i < 10; i++) expect((await post({ ...submission(log(8, 100), 10), note: 'x'.repeat(2_000_000) })).status).toBe(413)
      expect(witness.latest()).toBeUndefined()
    } finally {
      server.close()
    }
  })
})
