import { errorOf, WitnessCheckpointView, WitnessKeyView } from '@carwash/contracts'

export interface CheckpointRequest {
  size: number
  root: string
  from_size: number
  proof: string[]
}

export type SubmitReply = { kind: 'signed'; checkpoint: WitnessCheckpointView; fresh: boolean } | { kind: 'refused'; code: string; message: string }

export class WitnessClient {
  readonly #url: string
  readonly #token: string
  readonly #timeoutMs: number

  constructor(url: string, token: string, timeoutMs: number) {
    this.#url = url.replace(/\/+$/, '')
    this.#token = token
    this.#timeoutMs = timeoutMs
  }

  async key(): Promise<WitnessKeyView> {
    const { status, body } = await this.#request('GET', '/v1/key')
    if (status !== 200) throw new Error(`the witness answered ${status} for its key`)
    return WitnessKeyView.parse(body)
  }

  async latest(): Promise<WitnessCheckpointView | undefined> {
    const { status, body } = await this.#request('GET', '/v1/checkpoints/latest')
    if (status === 404) return undefined
    if (status !== 200) throw new Error(`the witness answered ${status} for its latest checkpoint`)
    return WitnessCheckpointView.parse(body)
  }

  async submit(request: CheckpointRequest): Promise<SubmitReply> {
    const { status, body } = await this.#request('POST', '/v1/checkpoints', request)
    if (status === 200 || status === 201) return { kind: 'signed', checkpoint: WitnessCheckpointView.parse(body), fresh: status === 201 }
    const refused = status === 409 ? errorOf(body) : undefined
    if (refused) return { kind: 'refused', code: refused.code, message: refused.message }
    throw new Error(`the witness answered ${status}: ${JSON.stringify(body)}`)
  }

  async #request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${this.#url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    })
    return { status: response.status, body: await response.json() }
  }
}
