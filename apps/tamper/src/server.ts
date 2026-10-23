import type { IncomingMessage, Server } from 'node:http'
import type { RestoredView, TamperState } from '@carwash/contracts'
import { bearerMatches, HttpError, parse, readJson, serve, type Reply } from '@carwash/http'
import * as z from 'zod/mini'
import { Conflict, type TamperService } from './service.ts'

const MAX_BODY_BYTES = 10_000

const TamperRequest = z.object(
  { class: z.union([z.literal(1), z.literal(2), z.literal(3)], { error: 'class must be 1, 2 or 3' }) },
  { error: 'the body must be a JSON object' },
)

export function createTamperServer(service: TamperService, token: string): Server {
  async function handle(request: IncomingMessage): Promise<Reply> {
    const route = `${String(request.method)} ${new URL(request.url ?? '/', 'http://tamper').pathname}`
    if (route === 'GET /health') return { status: 200, json: { ok: true } }
    if (!bearerMatches(request, token)) throw new HttpError(401, 'unauthorized', 'the token is missing or wrong')
    if (route === 'GET /v1/tamper') return { status: 200, json: { tamper: await service.current() } satisfies TamperState }
    if (route === 'POST /v1/tamper') {
      const body = parse(TamperRequest, await readJson(request, MAX_BODY_BYTES))
      return { status: 201, json: { tamper: await service.tamper(body.class) } satisfies TamperState }
    }
    if (route === 'POST /v1/restore') return { status: 200, json: { restored: await service.restore() } satisfies RestoredView }
    throw new HttpError(404, 'not_found', `no route ${route}`)
  }
  return serve(handle, {
    name: 'tamper',
    errorOf: (error) => (error instanceof Conflict ? new HttpError(409, error.code, error.message) : undefined),
  })
}
