import { sqlStateOf } from './sql-state.ts'

export class RetriesExhaustedError extends Error {
  readonly attempts: number

  constructor(attempts: number, options?: ErrorOptions) {
    super(`gave up after ${attempts} attempts`, options)
    this.name = new.target.name
    this.attempts = attempts
  }
}

export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY: RetryOptions = { maxAttempts: 6, baseDelayMs: 2, maxDelayMs: 200 }

const RETRYABLE = new Set(['40001', '40P01'])

export function isRetryable(error: unknown): boolean {
  const state = sqlStateOf(error)
  return state !== undefined && RETRYABLE.has(state)
}

export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ value: T; attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await run(attempt), attempts: attempt }
    } catch (error) {
      if (!isRetryable(error)) throw error
      if (attempt >= options.maxAttempts) throw new RetriesExhaustedError(attempt, { cause: error })
      const cap = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1))
      await sleep(Math.random() * cap)
    }
  }
}
