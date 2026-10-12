import { Inject, Injectable, Logger } from '@nestjs/common'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import type { AttemptKind } from './answers.ts'

export interface PspCall {
  attemptId: string
  kind: AttemptKind
  amount: bigint
  currency: string
  chargeId: string | null
  token: string | null
  destination: string | null
}

export type PspReply = { kind: 'answer'; httpStatus: number; body: unknown } | { kind: 'unknown'; reason: string }

const ANSWERED = new Set([200, 402, 409])

function route(call: PspCall): { path: string; body: Record<string, unknown> } {
  const amount = Number(call.amount)
  switch (call.kind) {
    case 'authorize':
      return { path: '/v1/charges', body: { amount, currency: call.currency, token: call.token } }
    case 'capture':
      return { path: `/v1/charges/${call.chargeId}/capture`, body: { amount } }
    case 'cancel':
      return { path: `/v1/charges/${call.chargeId}/cancel`, body: {} }
    case 'refund':
      return { path: `/v1/charges/${call.chargeId}/refunds`, body: { amount } }
    case 'payout':
      return { path: '/v1/payouts', body: { amount, currency: call.currency, destination: call.destination } }
  }
}

@Injectable()
export class PspClient {
  readonly #config: ApiConfig
  readonly #logger = new Logger('psp')

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.#config = config
  }

  async send(call: PspCall): Promise<PspReply> {
    const { path, body } = route(call)
    return this.#request('POST', path, call.attemptId, body)
  }

  async pull(attemptId: string): Promise<PspReply> {
    return this.#request('GET', `/v1/operations/${encodeURIComponent(attemptId)}`, undefined, undefined)
  }

  async #request(method: string, path: string, key: string | undefined, body: unknown): Promise<PspReply> {
    let response: Response
    try {
      response = await fetch(`${this.#config.pspUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#config.pspApiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#config.pspTimeoutMs),
      })
    } catch (error) {
      return { kind: 'unknown', reason: (error as Error).name === 'TimeoutError' ? 'timeout' : (error as Error).message }
    }
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return { kind: 'unknown', reason: `HTTP ${response.status} with a body that is not JSON` }
    }
    if (ANSWERED.has(response.status)) return { kind: 'answer', httpStatus: response.status, body: parsed }
    if (response.status >= 500 || response.status === 404) return { kind: 'unknown', reason: `HTTP ${response.status}` }
    this.#logger.error(`${method} ${path} was refused with ${response.status}: ${JSON.stringify(parsed)}`)
    return { kind: 'unknown', reason: `HTTP ${response.status}` }
  }
}
