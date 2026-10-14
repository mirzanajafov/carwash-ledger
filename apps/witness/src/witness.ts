import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { checkpointBody, fromHex, verifyConsistency, type Checkpoint } from '@carwash/audit'

export interface Signed extends Checkpoint {
  signature: string
  signed_at: string
}

export interface Submission extends Checkpoint {
  from_size: number
  proof: string[]
}

export class Refusal extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export class Witness {
  readonly #dir: string
  readonly #origin: string
  readonly #privateKey: KeyObject
  readonly #publicKey: KeyObject
  readonly #history: Signed[] = []
  #queue: Promise<unknown> = Promise.resolve()

  constructor(dir: string, origin: string) {
    this.#dir = dir
    this.#origin = origin
    mkdirSync(dir, { recursive: true })
    const keyFile = join(dir, 'witness.key')
    if (!existsSync(keyFile)) {
      const { privateKey } = generateKeyPairSync('ed25519')
      writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    }
    this.#privateKey = createPrivateKey(readFileSync(keyFile))
    this.#publicKey = createPublicKey(this.#privateKey)
    const log = join(dir, 'checkpoints.jsonl')
    if (existsSync(log)) {
      for (const line of readFileSync(log, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const signed = JSON.parse(line) as Signed
        if (!this.verify(signed)) throw new Error(`the witness log has a checkpoint at size ${signed.size} that its own key did not sign`)
        this.#history.push(signed)
      }
    }
  }

  get publicKey(): string {
    return this.#publicKey.export({ format: 'jwk' }).x!
  }

  get origin(): string {
    return this.#origin
  }

  latest(): Signed | undefined {
    return this.#history.at(-1)
  }

  history(): readonly Signed[] {
    return this.#history
  }

  verify(signed: Signed): boolean {
    return verify(null, Buffer.from(checkpointBody(signed, this.#origin)), this.#publicKey, Buffer.from(signed.signature, 'base64'))
  }

  submit(submission: Submission): Promise<{ signed: Signed; fresh: boolean }> {
    const result = this.#queue.then(() => this.#submit(submission))
    this.#queue = result.catch(() => undefined)
    return result
  }

  #submit(submission: Submission): { signed: Signed; fresh: boolean } {
    const body = checkpointBody(submission, this.#origin)
    const last = this.latest()
    if (last) {
      if (submission.size < last.size) throw new Refusal('rollback', `the log was at ${last.size} and now says ${submission.size}`)
      if (submission.size === last.size) {
        if (submission.root !== last.root) throw new Refusal('fork', `size ${last.size} already has root ${last.root}`)
        return { signed: last, fresh: false }
      }
      if (submission.from_size !== last.size) throw new Refusal('stale', `the proof must start at ${last.size}, not ${submission.from_size}`)
      if (!verifyConsistency(last.size, submission.size, fromHex(last.root), fromHex(submission.root), submission.proof.map(fromHex))) {
        throw new Refusal('inconsistent', `${submission.size} is not an extension of the log at ${last.size}`)
      }
    }
    const signed: Signed = {
      size: submission.size,
      root: submission.root,
      signature: sign(null, Buffer.from(body), this.#privateKey).toString('base64'),
      signed_at: new Date().toISOString(),
    }
    const fd = openSync(join(this.#dir, 'checkpoints.jsonl'), 'a')
    try {
      writeSync(fd, `${JSON.stringify(signed)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.#history.push(signed)
    return { signed, fresh: true }
  }
}
