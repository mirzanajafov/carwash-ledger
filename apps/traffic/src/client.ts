import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { errorOf } from '@carwash/contracts'

export interface Answer {
  status: number
  body: unknown
}

export class ApiClient {
  readonly #url: string
  readonly #signal: AbortSignal

  constructor(url: string, signal: AbortSignal) {
    this.#url = url.replace(/\/+$/, '')
    this.#signal = signal
  }

  async send(key: string, method: string, path: string, body?: unknown, idempotencyKey: string = randomUUID()): Promise<Answer> {
    let delay = 250
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${this.#url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${key}`,
            ...(method === 'POST' ? { 'idempotency-key': idempotencyKey } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? null : JSON.stringify(body),
          signal: AbortSignal.any([this.#signal, AbortSignal.timeout(10_000)]),
        })
        const answer: Answer = { status: response.status, body: await response.json().catch(() => null) }
        const retry = response.status >= 500 || (response.status === 409 && errorOf(answer.body)?.code === 'request_in_progress') || response.status === 429
        if (!retry || attempt >= 30) return answer
        const after = Number(response.headers.get('retry-after'))
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : delay, undefined, { signal: this.#signal })
      } catch (error) {
        if (this.#signal.aborted || attempt >= 30) throw error
        await sleep(delay, undefined, { signal: this.#signal })
      }
      delay = Math.min(delay * 2, 5000)
    }
  }
}
