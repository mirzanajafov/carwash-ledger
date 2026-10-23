import type { IncomingMessage, Server } from 'node:http'
import { CheckpointSubmission, type WitnessKeyView } from '@carwash/contracts'
import { bearerMatches, HttpError, parse, readJson, serve, type Reply } from '@carwash/http'
import { Refusal, Witness } from './witness.ts'

const MAX_BODY_BYTES = 1_000_000

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
    if (route === 'GET /v1/key') {
      return { status: 200, json: { origin: witness.origin, algorithm: 'ed25519', public_key: witness.publicKey } satisfies WitnessKeyView }
    }
    if (route === 'GET /v1/checkpoints/latest') {
      const latest = witness.latest()
      if (!latest) throw new HttpError(404, 'none', 'nothing is signed yet')
      return { status: 200, json: latest }
    }
    if (route === 'GET /v1/checkpoints') return { status: 200, stream: historyDocument(witness), contentType: 'application/json' }
    if (route === 'POST /v1/checkpoints') {
      if (!bearerMatches(request, token)) throw new HttpError(401, 'unauthorized', 'the submitter token is missing or wrong')
      const { signed, fresh } = await witness.submit(parse(CheckpointSubmission, await readJson(request, MAX_BODY_BYTES)))
      return { status: fresh ? 201 : 200, json: signed }
    }
    throw new HttpError(404, 'not_found', `no route ${route}`)
  }
  return serve(handle, {
    name: 'witness',
    mapError: (error) => (error instanceof Refusal ? new HttpError(409, error.code, error.message) : undefined),
  })
}
