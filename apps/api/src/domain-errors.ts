export type Failure = 'invalid' | 'not_found' | 'conflict' | 'unprocessable' | 'upstream' | 'unavailable'

const REFUSALS: ReadonlySet<Failure> = new Set(['invalid', 'not_found', 'conflict', 'unprocessable'])

export class DomainError extends Error {
  readonly failure: Failure
  readonly code: string
  readonly retryAfterSeconds: number | undefined

  constructor(failure: Failure, code: string, message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = new.target.name
    this.failure = failure
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }

  get refusal(): boolean {
    return REFUSALS.has(this.failure)
  }
}

export function invalidInput(message: string): DomainError {
  return new DomainError('invalid', 'invalid_request', message)
}

export function notFound(what: string): DomainError {
  return new DomainError('not_found', 'not_found', `${what} does not exist`)
}
