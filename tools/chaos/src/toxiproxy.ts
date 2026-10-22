import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ToxicKind } from './plan.ts'
import type { Random } from './random.ts'
import { between } from './random.ts'

export interface Toxic {
  name: string
  type: string
  stream: 'upstream' | 'downstream'
  toxicity: number
  attributes: Record<string, number>
}

export function toxicFor(kind: Exclude<ToxicKind, 'down'>, name: string, random: Random): Toxic {
  const base = { name, stream: 'downstream' as const, toxicity: 1 }
  switch (kind) {
    case 'latency':
      return { ...base, type: 'latency', attributes: { latency: between(random, 50, 500), jitter: 50 } }
    case 'timeout':
      return { ...base, type: 'timeout', attributes: { timeout: 0 } }
    case 'reset_peer':
      return { ...base, type: 'reset_peer', attributes: { timeout: 0 } }
    case 'limit_data':
      return { ...base, type: 'limit_data', attributes: { bytes: between(random, 200, 20_000) } }
  }
}

export class Toxiproxy {
  readonly #api: string
  #child: ChildProcess | undefined

  constructor(port = 8474) {
    this.#api = `http://127.0.0.1:${port}`
  }

  start(): void {
    this.#child = spawn('toxiproxy-server', ['-host', '127.0.0.1', '-port', new URL(this.#api).port], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  }

  async waitReady(timeoutMs = 10_000): Promise<void> {
    const started = performance.now()
    for (;;) {
      try {
        const response = await fetch(`${this.#api}/version`)
        if (response.ok) return
      } catch (error) {
        if (performance.now() - started > timeoutMs) throw error
      }
      await sleep(100)
    }
  }

  async #call(method: string, path: string, body?: unknown): Promise<void> {
    await callWithRetries(
      () =>
        fetch(`${this.#api}${path}`, {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        }),
      `toxiproxy ${method} ${path}`,
    )
  }

  async replaceProxy(name: string, listenPort: number, upstreamPort: number): Promise<void> {
    await this.#call('DELETE', `/proxies/${name}`)
    await this.#call('POST', '/proxies', {
      name,
      listen: `127.0.0.1:${listenPort}`,
      upstream: `127.0.0.1:${upstreamPort}`,
      enabled: true,
    })
  }

  setEnabled(name: string, enabled: boolean): Promise<void> {
    return this.#call('POST', `/proxies/${name}`, { enabled })
  }

  addToxic(proxy: string, toxic: Toxic): Promise<void> {
    return this.#call('POST', `/proxies/${proxy}/toxics`, toxic)
  }

  removeToxic(proxy: string, name: string): Promise<void> {
    return this.#call('DELETE', `/proxies/${proxy}/toxics/${name}`)
  }

  reset(): Promise<void> {
    return this.#call('POST', '/reset')
  }

  stop(): void {
    this.#child?.kill('SIGTERM')
  }
}

export async function callWithRetries(
  send: () => Promise<Response>,
  what: string,
  attempts = 5,
  pause: (ms: number) => Promise<unknown> = sleep,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let failure: string
    try {
      const response = await send()
      if (response.ok || response.status === 404 || (attempt > 0 && response.status === 409)) return
      failure = `${response.status} ${await response.text()}`
      if (response.status < 500) throw new Error(`${what}: ${failure}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${what}: `)) throw error
      failure = error instanceof Error ? error.message : String(error)
    }
    if (attempt + 1 >= attempts) throw new Error(`${what}: ${failure} after ${attempts} attempts`)
    await pause(200 * 2 ** attempt)
  }
}
