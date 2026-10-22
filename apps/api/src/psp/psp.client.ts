import { Inject, Injectable, Logger } from '@nestjs/common'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import type { AttemptId } from '../ids.ts'
import type { AttemptKind } from './answers.ts'

export interface PspCall {
  attemptId: AttemptId
  kind: AttemptKind
  amount: bigint
  currency: string
  chargeId: string | null
  token: string | null
  destination: string | null
}

export type PspReply = { kind: 'answer'; httpStatus: number; body: unknown } | { kind: 'unknown'; reason: string }

export type CalendarReply = { kind: 'answer'; daySeconds: number; currentDay: number } | { kind: 'unknown'; reason: string }

export type FileReply = { kind: 'file'; csv: string } | { kind: 'not_ready' } | { kind: 'unknown'; reason: string }

export type PullReply = { kind: 'answer'; body: unknown } | { kind: 'none' } | { kind: 'unknown'; reason: string }

type Raw = { kind: 'http'; status: number; body: unknown } | { kind: 'unknown'; reason: string }

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
    const raw = await this.#request('POST', path, call.attemptId, body)
    if (raw.kind === 'unknown') return raw
    if (ANSWERED.has(raw.status)) return { kind: 'answer', httpStatus: raw.status, body: raw.body }
    if (raw.status < 500 && raw.status !== 404) this.#logger.error(`POST ${path} was refused with ${raw.status}: ${JSON.stringify(raw.body)}`)
    return { kind: 'unknown', reason: `HTTP ${raw.status}` }
  }

  async pull(attemptId: string): Promise<PullReply> {
    const raw = await this.#request('GET', `/v1/operations/${encodeURIComponent(attemptId)}`, undefined, undefined)
    if (raw.kind === 'unknown') return raw
    if (raw.status === 200) return { kind: 'answer', body: raw.body }
    if (raw.status === 404) return { kind: 'none' }
    return { kind: 'unknown', reason: `HTTP ${raw.status}` }
  }

  async calendar(): Promise<CalendarReply> {
    const raw = await this.#request('GET', '/v1/settlements', undefined, undefined)
    if (raw.kind === 'unknown') return raw
    if (raw.status !== 200) return { kind: 'unknown', reason: `HTTP ${raw.status}` }
    const body = raw.body as { day_seconds?: unknown; current_day?: unknown }
    if (!Number.isSafeInteger(body.day_seconds) || !Number.isSafeInteger(body.current_day)) return { kind: 'unknown', reason: 'calendar without numbers' }
    return { kind: 'answer', daySeconds: body.day_seconds as number, currentDay: body.current_day as number }
  }

  async settlementFile(day: number, currency: string): Promise<FileReply> {
    try {
      const response = await fetch(`${this.#config.pspUrl}/v1/settlements/${day}?currency=${encodeURIComponent(currency)}`, {
        headers: { authorization: `Bearer ${this.#config.pspApiKey}` },
        signal: AbortSignal.timeout(Math.max(this.#config.pspTimeoutMs, 30_000)),
      })
      if (response.status === 404) return { kind: 'not_ready' }
      if (response.status !== 200) return { kind: 'unknown', reason: `HTTP ${response.status}` }
      return { kind: 'file', csv: await response.text() }
    } catch (error) {
      return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async #request(method: string, path: string, key: string | undefined, body: unknown): Promise<Raw> {
    let response: Response
    try {
      response = await fetch(`${this.#config.pspUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#config.pspApiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#config.pspTimeoutMs),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') return { kind: 'unknown', reason: 'timeout' }
      return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
    try {
      return { kind: 'http', status: response.status, body: await response.json() }
    } catch {
      return { kind: 'unknown', reason: `HTTP ${response.status} with a body that is not JSON` }
    }
  }
}
