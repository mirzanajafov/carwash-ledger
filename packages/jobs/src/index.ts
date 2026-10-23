import { setTimeout as sleep } from 'node:timers/promises'

export interface LoopOptions {
  signal: AbortSignal
  log: (message: string) => void
  logEvery?: number
}

export class Failures {
  readonly #label: string
  readonly #log: (message: string) => void
  readonly #logEvery: number
  #count = 0

  constructor(label: string, log: (message: string) => void, logEvery = 1) {
    this.#label = label
    this.#log = log
    this.#logEvery = logEvery
  }

  record(error: unknown): number {
    this.#count++
    if (this.#count === 1 || this.#count % this.#logEvery === 0) this.#log(`${this.#label}: ${error instanceof Error ? error.message : String(error)}`)
    return this.#count
  }

  clear(): void {
    this.#count = 0
  }
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return sleep(ms, undefined, { signal }).catch(() => undefined)
}

export function exponentialBackoff(failures: number): number {
  return Math.min(2000, 50 * 2 ** Math.min(failures, 6))
}

export function linearBackoff(failures: number): number {
  return Math.min(5000, 250 * failures)
}

export async function runEvery(label: string, intervalMs: number, task: () => Promise<unknown>, options: LoopOptions): Promise<void> {
  const failures = new Failures(label, options.log, options.logEvery)
  while (!options.signal.aborted) {
    try {
      await task()
      failures.clear()
    } catch (error) {
      failures.record(error)
    }
    await pause(intervalMs, options.signal)
  }
}

export async function retryLoop<T>(label: string, task: () => Promise<T>, delayMs: (failures: number) => number, options: LoopOptions): Promise<T | undefined> {
  const failures = new Failures(label, options.log, options.logEvery)
  while (!options.signal.aborted) {
    try {
      return await task()
    } catch (error) {
      await pause(delayMs(failures.record(error)), options.signal)
    }
  }
  return undefined
}
