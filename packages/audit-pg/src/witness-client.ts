export interface SignedCheckpoint {
  size: number
  root: string
  signature: string
  signed_at: string
}

export interface WitnessKey {
  origin: string
  algorithm: string
  public_key: string
}

export interface CheckpointRequest {
  size: number
  root: string
  from_size: number
  proof: string[]
}

export type SubmitReply = { kind: 'signed'; checkpoint: SignedCheckpoint; fresh: boolean } | { kind: 'refused'; code: string; message: string }

export class WitnessClient {
  readonly #url: string
  readonly #token: string
  readonly #timeoutMs: number

  constructor(url: string, token: string, timeoutMs: number) {
    this.#url = url.replace(/\/+$/, '')
    this.#token = token
    this.#timeoutMs = timeoutMs
  }

  async key(): Promise<WitnessKey> {
    const { status, body } = await this.#request('GET', '/v1/key')
    if (status !== 200) throw new Error(`the witness answered ${status} for its key`)
    return body as WitnessKey
  }

  async latest(): Promise<SignedCheckpoint | undefined> {
    const { status, body } = await this.#request('GET', '/v1/checkpoints/latest')
    if (status === 404) return undefined
    if (status !== 200) throw new Error(`the witness answered ${status} for its latest checkpoint`)
    return body as SignedCheckpoint
  }

  async history(): Promise<SignedCheckpoint[]> {
    const { status, body } = await this.#request('GET', '/v1/checkpoints')
    if (status !== 200) throw new Error(`the witness answered ${status} for its checkpoints`)
    return (body as { data: SignedCheckpoint[] }).data
  }

  async submit(request: CheckpointRequest): Promise<SubmitReply> {
    const { status, body } = await this.#request('POST', '/v1/checkpoints', request)
    if (status === 200 || status === 201) return { kind: 'signed', checkpoint: body as SignedCheckpoint, fresh: status === 201 }
    if (status === 409) {
      const { error } = body as { error: { code: string; message: string } }
      return { kind: 'refused', code: error.code, message: error.message }
    }
    throw new Error(`the witness answered ${status}: ${JSON.stringify(body)}`)
  }

  async #request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${this.#url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    })
    return { status: response.status, body: await response.json() }
  }
}
