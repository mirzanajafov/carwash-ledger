import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseFaultPlan, parseToken, parseWeather, type Faults, type TokenEffect } from './faults.ts'
import {
  amountField,
  badRequest,
  bearerMatches,
  currencyField,
  HttpError,
  onlyFields,
  optionalAmountField,
  readJson,
  sendError,
  sendJson,
  sendText,
  textField,
} from './http.ts'
import { requestHash, type Answer, type OperationRequest, type Psp } from './psp.ts'
import type { Settlements } from './settlement.ts'

export interface ServerOptions {
  apiKey: string
  adminKey: string
  hangMs: number
  log?: (message: string) => void
}

const CHARGE_ACTION = /^\/v1\/charges\/(ch_[0-9a-f-]{36})\/(capture|cancel|refunds)$/
const CHARGE = /^\/v1\/charges\/(ch_[0-9a-f-]{36})$/
const OPERATION = /^\/v1\/operations\/([^/]{1,255})$/
const SETTLEMENT = /^\/v1\/settlements\/(\d{1,12})$/
const CLOSE_DAY = /^\/admin\/settlements\/(\d{1,12})\/close$/

function idempotencyKey(request: IncomingMessage): string {
  const key = request.headers['idempotency-key']
  if (typeof key !== 'string' || key.length === 0 || key.length > 255) {
    throw badRequest('every POST needs an Idempotency-Key header of 1 to 255 characters')
  }
  return key
}

function tokenEffect(token: string): TokenEffect {
  const effect = parseToken(token)
  if (!effect) throw new HttpError(400, 'invalid_token', `unknown test token ${token}`)
  return effect
}

function weatherView(faults: Faults) {
  const weather = faults.weather
  return {
    base: faults.base,
    weather: weather ? { label: weather.label, plan: weather.plan, until: new Date(weather.until).toISOString() } : null,
  }
}

export function createPspServer(psp: Psp, faults: Faults, settlements: Settlements, options: ServerOptions): Server {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`))

  async function post(request: IncomingMessage, path: string): Promise<Answer> {
    const key = idempotencyKey(request)
    const body = await readJson(request)
    const hash = requestHash('POST', path, body)

    if (path === '/v1/charges') {
      onlyFields(body, ['amount', 'currency', 'token'])
      const input = { amount: amountField(body, 'amount'), currency: currencyField(body, 'currency'), token: textField(body, 'token') }
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
      onlyFields(body, ['amount', 'currency', 'destination'])
      const input = { amount: amountField(body, 'amount'), currency: currencyField(body, 'currency'), destination: textField(body, 'destination') }
      return psp.execute({ key, kind: 'payout', hash, token: { kind: 'ok' }, apply: async (_client, behaviour) => psp.payout(behaviour, input) })
    }
    const action = CHARGE_ACTION.exec(path)
    if (!action) throw new HttpError(404, 'not_found', `no route POST ${path}`)
    const chargeId = action[1]!
    const token = tokenEffect(await psp.chargeToken(chargeId))
    let operation: Pick<OperationRequest, 'kind' | 'apply'>
    if (action[2] === 'capture') {
      onlyFields(body, ['amount'])
      const amount = optionalAmountField(body, 'amount')
      operation = { kind: 'capture', apply: (client, behaviour) => psp.capture(client, behaviour, chargeId, amount) }
    } else if (action[2] === 'cancel') {
      onlyFields(body, [])
      operation = { kind: 'cancel', apply: (client) => psp.cancel(client, chargeId) }
    } else {
      onlyFields(body, ['amount'])
      const amount = amountField(body, 'amount')
      operation = { kind: 'refund', apply: (client, behaviour) => psp.refund(client, behaviour, chargeId, amount) }
    }
    return psp.execute({ key, hash, token, ...operation })
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://psp').pathname
    const method = request.method ?? 'GET'
    if (method === 'GET' && path === '/health') return sendJson(response, 200, { ok: true })

    if (path.startsWith('/admin/')) {
      if (!bearerMatches(request, options.adminKey)) throw new HttpError(401, 'unauthorized', 'the admin key is missing or wrong')
      const close = CLOSE_DAY.exec(path)
      if (close && method === 'PUT') {
        await settlements.close(Number(close[1]))
        return sendJson(response, 200, { day: Number(close[1]), closed: true })
      }
      if (path === '/admin/weather') {
        if (method === 'PUT') {
          let weather
          try {
            weather = parseWeather(await readJson(request))
          } catch (error) {
            if (error instanceof HttpError) throw error
            throw badRequest((error as Error).message)
          }
          faults.setWeather(weather.label, weather.plan, weather.seconds)
        } else if (method === 'DELETE') {
          faults.clearWeather()
        } else if (method !== 'GET') {
          throw new HttpError(405, 'method_not_allowed', `${method} is not allowed on ${path}`)
        }
        return sendJson(response, 200, weatherView(faults))
      }
      if (path !== '/admin/faults') throw new HttpError(404, 'not_found', `no route ${method} ${path}`)
      if (method === 'PUT') {
        try {
          faults.plan = parseFaultPlan(await readJson(request))
        } catch (error) {
          if (error instanceof HttpError) throw error
          throw badRequest((error as Error).message)
        }
      } else if (method !== 'GET') {
        throw new HttpError(405, 'method_not_allowed', `${method} is not allowed on ${path}`)
      }
      return sendJson(response, 200, faults.plan)
    }

    if (!bearerMatches(request, options.apiKey)) throw new HttpError(401, 'unauthorized', 'the API key is missing or wrong')
    if (method === 'GET') {
      const charge = CHARGE.exec(path)
      if (charge) return sendJson(response, 200, await psp.charge(charge[1]!))
      const operation = OPERATION.exec(path)
      if (operation) return sendJson(response, 200, await psp.operation(decodeURIComponent(operation[1]!)))
      if (path === '/v1/settlements') return sendJson(response, 200, settlements.calendar())
      const settlement = SETTLEMENT.exec(path)
      if (settlement) {
        const currency = new URL(request.url ?? '/', 'http://psp').searchParams.get('currency') ?? ''
        if (!/^[A-Z]{3}$/.test(currency)) throw badRequest('currency must be a three-letter code')
        const file = await settlements.file(Number(settlement[1]), currency)
        if (!file) throw new HttpError(404, 'settlement_not_ready', `day ${settlement[1]} is not closed yet`)
        return sendText(response, 200, 'text/csv', file.csv)
      }
      throw new HttpError(404, 'not_found', `no route GET ${path}`)
    }
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', `${method} is not allowed on ${path}`)

    const answer = await post(request, path)
    if (answer.afterCommit === 'drop') {
      request.socket.destroy()
      return
    }
    if (answer.afterCommit === 'hang') {
      await sleep(options.hangMs)
      if (request.socket.destroyed) return
    }
    sendJson(response, answer.status, answer.body, answer.replayed ? { 'idempotent-replayed': 'true' } : {})
  }

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent || request.socket.destroyed) return
      if (error instanceof HttpError) return sendError(response, error)
      log(`psp: ${(error as Error).stack ?? String(error)}`)
      sendError(response, new HttpError(500, 'internal_error', 'internal error'))
    })
  })
}
