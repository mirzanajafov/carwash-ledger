import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { checkpointBody, fromHex, verifyConsistency, type Checkpoint } from '@carwash/audit'
import { WitnessCheckpointView } from '@carwash/contracts'

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

const TAIL_CHUNK = 4096
const LONGEST_LINE = 65_536

function lastLine(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  const fd = openSync(path, 'r')
  try {
    let tail = Buffer.alloc(0)
    for (let position = fstatSync(fd).size; position > 0;) {
      if (tail.length > LONGEST_LINE) throw new Error(`the last line of ${path} is longer than ${LONGEST_LINE} bytes`)
      const length = Math.min(TAIL_CHUNK, position)
      position -= length
      const chunk = Buffer.alloc(length)
      if (readSync(fd, chunk, 0, length, position) !== length) throw new Error(`${path} changed while its last line was read`)
      tail = Buffer.concat([chunk, tail])
      const lines = tail
        .toString('utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
      if (lines.length > 1 || (position === 0 && lines.length === 1)) return lines.at(-1)
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}

export class Witness {
  readonly #origin: string
  readonly #privateKey: KeyObject
  readonly #publicKey: KeyObject
  readonly #log: string
  #latest: WitnessCheckpointView | undefined
  #queue: Promise<unknown> = Promise.resolve()

  constructor(dir: string, origin: string) {
    this.#origin = origin
    mkdirSync(dir, { recursive: true })
    const keyFile = join(dir, 'witness.key')
    if (!existsSync(keyFile)) {
      const { privateKey } = generateKeyPairSync('ed25519')
      writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    }
    this.#privateKey = createPrivateKey(readFileSync(keyFile))
    this.#publicKey = createPublicKey(this.#privateKey)
    this.#log = join(dir, 'checkpoints.jsonl')
    const line = lastLine(this.#log)
    if (line === undefined) return
    const parsed = WitnessCheckpointView.safeParse(JSON.parse(line))
    if (!parsed.success) throw new Error(`the witness log ends with a line that is not a signed checkpoint: ${line.slice(0, 200)}`)
    const signed = parsed.data
    if (!this.verify(signed)) throw new Error(`the witness log ends with a checkpoint at size ${signed.size} that its own key did not sign`)
    this.#latest = signed
  }

  get publicKey(): string {
    const { x } = this.#publicKey.export({ format: 'jwk' })
    if (!x) throw new Error('an Ed25519 key exports its public half as x')
    return x
  }

  get origin(): string {
    return this.#origin
  }

  latest(): WitnessCheckpointView | undefined {
    return this.#latest
  }

  async *history(): AsyncGenerator<string> {
    if (!existsSync(this.#log)) return
    const end = statSync(this.#log).size
    if (end === 0) return
    const input = createReadStream(this.#log, { end: end - 1 })
    try {
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        if (line.trim() !== '') yield line
      }
    } finally {
      input.destroy()
    }
  }

  verify(signed: WitnessCheckpointView): boolean {
    return verify(null, Buffer.from(checkpointBody(signed, this.#origin)), this.#publicKey, Buffer.from(signed.signature, 'base64'))
  }

  submit(submission: Submission): Promise<{ signed: WitnessCheckpointView; fresh: boolean }> {
    const result = this.#queue.then(() => this.#submit(submission))
    this.#queue = result.catch(() => undefined)
    return result
  }

  #submit(submission: Submission): { signed: WitnessCheckpointView; fresh: boolean } {
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
    const signed: WitnessCheckpointView = {
      size: submission.size,
      root: submission.root,
      signature: sign(null, Buffer.from(body), this.#privateKey).toString('base64'),
      signed_at: new Date().toISOString(),
    }
    const fd = openSync(this.#log, 'a')
    try {
      writeSync(fd, `${JSON.stringify(signed)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.#latest = signed
    return { signed, fresh: true }
  }
}
