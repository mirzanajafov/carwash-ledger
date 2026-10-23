import type { IncomingMessage, Server } from 'node:http'
import { bearerMatches, HttpError, parse, readJson, serve, type Reply } from '@carwash/http'
import * as z from 'zod/mini'
import { Refusal, Witness } from './witness.ts'

const MAX_BODY_BYTES = 1_000_000

const PROOF = 'proof must be a list of hex hashes'

function integerFrom(min: number, error: string) {
  return z.int({ error }).check(z.gte(min, { error }))
}

function hash(error: string) {
  return z.string({ error }).check(z.regex(/^[0-9a-f]{64}$/, { error }))
}

const SubmissionRequest = z.object(
  {
    size: integerFrom(1, 'size must be a positive integer'),
    from_size: z._default(integerFrom(0, 'from_size must be a non-negative integer'), 0),
    root: hash('root must be 32 bytes of hex'),
    proof: z._default(z.array(hash(PROOF), { error: PROOF }).check(z.maxLength(64, { error: PROOF })), []),
  },
  { error: 'the body must be a JSON object' },
)

async function* historyDocument(witness: Witness): AsyncGenerator<string> {
  yield '{"data":['
  let separator = ''
  for await (const line of witness.history()) {
    yield separator + line
    separator = ','
  }
  yield ']}'
}

export function createWitnessServer(witness: Witness, token: string): Server {
  async function handle(request: IncomingMessage): Promise<Reply> {
    const url = new URL(request.url ?? '/', 'http://witness')
    const route = `${String(request.method)} ${url.pathname}`
    if (route === 'GET /health') return { status: 200, json: { ok: true } }
    if (route === 'GET /v1/key') return { status: 200, json: { origin: witness.origin, algorithm: 'ed25519', public_key: witness.publicKey } }
    if (route === 'GET /v1/checkpoints/latest') {
      const latest = witness.latest()
      if (!latest) throw new HttpError(404, 'none', 'nothing is signed yet')
      return { status: 200, json: latest }
    }
    if (route === 'GET /v1/checkpoints') return { status: 200, stream: historyDocument(witness), contentType: 'application/json' }
    if (route === 'POST /v1/checkpoints') {
      if (!bearerMatches(request, token)) throw new HttpError(401, 'unauthorized', 'the submitter token is missing or wrong')
      const { signed, fresh } = await witness.submit(parse(SubmissionRequest, await readJson(request, MAX_BODY_BYTES)))
      return { status: fresh ? 201 : 200, json: signed }
    }
    throw new HttpError(404, 'not_found', `no route ${route}`)
  }
  return serve(handle, {
    name: 'witness',
    mapError: (error) => (error instanceof Refusal ? new HttpError(409, error.code, error.message) : undefined),
  })
}
