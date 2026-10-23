import type { IncomingMessage, Server } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import type { WeatherView } from '@carwash/contracts'
import { bearerMatches, HttpError, parse, readJson, serve, type Reply } from '@carwash/http'
import { FaultPlanInput, parseToken, WeatherRequest, type Faults, type TokenEffect } from './faults.ts'
import { requestHash, type Answer, type OperationRequest, type Psp } from './psp.ts'
import { CancelRequest, CaptureRequest, ChargeRequest, PayoutRequest, RefundRequest } from './requests.ts'
import type { Settlements } from './settlement.ts'

export interface ServerOptions {
  apiKey: string
  adminKey: string
  hangMs: number
  log: (message: string) => void
}

const MAX_BODY_BYTES = 16 * 1024
const INVALID = 'invalid_request'

const CHARGE_ACTION = /^\/v1\/charges\/(ch_[0-9a-f-]{36})\/(capture|cancel|refunds)$/
const CHARGE = /^\/v1\/charges\/(ch_[0-9a-f-]{36})$/
const OPERATION = /^\/v1\/operations\/([^/]{1,255})$/
const SETTLEMENT = /^\/v1\/settlements\/(\d{1,12})$/
const CLOSE_DAY = /^\/admin\/settlements\/(\d{1,12})\/close$/

function idempotencyKey(request: IncomingMessage): string {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || key.length === 0 || key.length > 255) {
    throw new HttpError(400, INVALID, 'every POST needs an Idempotency-Key header of 1 to 255 characters')
  }
  return key
}

function tokenEffect(token: string): TokenEffect {
  const effect = parseToken(token)
  if (!effect) throw new HttpError(400, 'invalid_token', `unknown test token ${token}`)
  return effect
}

function weatherView(faults: Faults): WeatherView {
  const weather = faults.weather
  return {
    base: faults.base,
    weather: weather ? { label: weather.label, plan: weather.plan, until: new Date(weather.until).toISOString() } : null,
  }
}

function notAllowed(method: string, path: string): HttpError {
  return new HttpError(405, 'method_not_allowed', `${method} is not allowed on ${path}`)
}

export function createPspServer(psp: Psp, faults: Faults, settlements: Settlements, options: ServerOptions): Server {
  async function post(request: IncomingMessage, path: string): Promise<Answer> {
    const key = idempotencyKey(request)
    const body = await readJson(request, MAX_BODY_BYTES, INVALID)
    const hash = requestHash('POST', path, body)

    if (path === '/v1/charges') {
      const input = parse(ChargeRequest, body, INVALID)
      const effect = tokenEffect(input.token)
      return psp.execute({
        key,
        kind: 'authorize',
        hash,
        token: effect,
        apply: (client, behaviour) => psp.authorize(client, behaviour, { ...input, effect }),
      })
    }
    if (path === '/v1/payouts') {
      const input = parse(PayoutRequest, body, INVALID)
      return psp.execute({ key, kind: 'payout', hash, token: { kind: 'ok' }, apply: async (_client, behaviour) => psp.payout(behaviour, input) })
    }
    const [, chargeId, verb] = CHARGE_ACTION.exec(path) ?? []
    if (chargeId === undefined) throw new HttpError(404, 'not_found', `no route POST ${path}`)
    let operation: Pick<OperationRequest, 'kind' | 'apply'>
    if (verb === 'capture') {
      const { amount } = parse(CaptureRequest, body, INVALID)
      operation = { kind: 'capture', apply: (client, behaviour) => psp.capture(client, behaviour, chargeId, amount) }
    } else if (verb === 'cancel') {
      parse(CancelRequest, body, INVALID)
      operation = { kind: 'cancel', apply: (client) => psp.cancel(client, chargeId) }
    } else {
      const { amount } = parse(RefundRequest, body, INVALID)
      operation = { kind: 'refund', apply: (client, behaviour) => psp.refund(client, behaviour, chargeId, amount) }
    }
    const token = tokenEffect(await psp.chargeToken(chargeId))
    return psp.execute({ key, hash, token, ...operation })
  }

  async function admin(request: IncomingMessage, method: string, path: string): Promise<Reply> {
    if (!bearerMatches(request, options.adminKey)) throw new HttpError(401, 'unauthorized', 'the admin key is missing or wrong')
    const [, closeDay] = CLOSE_DAY.exec(path) ?? []
    if (closeDay !== undefined && method === 'PUT') {
      await settlements.close(Number(closeDay))
      return { status: 200, json: { day: Number(closeDay), closed: true } }
    }
    if (path === '/admin/weather') {
      if (method === 'PUT') {
        const weather = parse(WeatherRequest, await readJson(request, MAX_BODY_BYTES, INVALID), INVALID)
        faults.setWeather(weather.label, weather.plan, weather.seconds)
      } else if (method === 'DELETE') {
        faults.clearWeather()
      } else if (method !== 'GET') {
        throw notAllowed(method, path)
      }
      return { status: 200, json: weatherView(faults) }
    }
    if (path !== '/admin/faults') throw new HttpError(404, 'not_found', `no route ${method} ${path}`)
    if (method === 'PUT') faults.plan = parse(FaultPlanInput, await readJson(request, MAX_BODY_BYTES, INVALID), INVALID)
    else if (method !== 'GET') throw notAllowed(method, path)
    return { status: 200, json: faults.plan }
  }

  async function read(request: IncomingMessage, path: string): Promise<Reply> {
    const [, chargeId] = CHARGE.exec(path) ?? []
    if (chargeId !== undefined) return { status: 200, json: await psp.charge(chargeId) }
    const [, operationId] = OPERATION.exec(path) ?? []
    if (operationId !== undefined) return { status: 200, json: await psp.operation(decodeURIComponent(operationId)) }
    if (path === '/v1/settlements') return { status: 200, json: settlements.calendar() }
    const [, settlementDay] = SETTLEMENT.exec(path) ?? []
    if (settlementDay === undefined) throw new HttpError(404, 'not_found', `no route GET ${path}`)
    const currency = new URL(request.url ?? '/', 'http://psp').searchParams.get('currency') ?? ''
    if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, INVALID, 'currency must be a three-letter code')
    const file = await settlements.file(Number(settlementDay), currency)
    if (!file) throw new HttpError(404, 'settlement_not_ready', `day ${settlementDay} is not closed yet`)
    return { status: 200, text: file.csv, contentType: 'text/csv' }
  }

  async function handle(request: IncomingMessage): Promise<Reply | undefined> {
    const path = new URL(request.url ?? '/', 'http://psp').pathname
    const method = request.method ?? 'GET'
    if (method === 'GET' && path === '/health') return { status: 200, json: { ok: true } }
    if (path.startsWith('/admin/')) return admin(request, method, path)
    if (!bearerMatches(request, options.apiKey)) throw new HttpError(401, 'unauthorized', 'the API key is missing or wrong')
    if (method === 'GET') return read(request, path)
    if (method !== 'POST') throw notAllowed(method, path)

    const answer = await post(request, path)
    if (answer.afterCommit === 'drop') {
      request.socket.destroy()
      return undefined
    }
    if (answer.afterCommit === 'hang') {
      await sleep(options.hangMs)
      if (request.socket.destroyed) return undefined
    }
    return { status: answer.status, json: answer.body, headers: answer.replayed ? { 'idempotent-replayed': 'true' } : {} }
  }

  return serve(handle, { name: 'psp', log: options.log })
}
