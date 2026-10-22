export type Failure = 'invalid' | 'not_found' | 'conflict' | 'unprocessable' | 'upstream' | 'unavailable'

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
    return this.failure !== 'upstream' && this.failure !== 'unavailable'
  }
}

export class PspUnavailableError extends DomainError {
  constructor(message: string, retryAfterSeconds = 1) {
    super('unavailable', 'psp_unavailable', message, retryAfterSeconds)
  }
}

export class PspAnswerRejectedError extends DomainError {
  constructor() {
    super('upstream', 'psp_answer_rejected', 'the PSP answered something that does not match the request, and the answer is recorded as an anomaly')
  }
}

export function invalidInput(message: string): DomainError {
  return new DomainError('invalid', 'invalid_request', message)
}

export function notFound(what: string): DomainError {
  return new DomainError('not_found', 'not_found', `${what} does not exist`)
}

export function pspUnavailable(reason: string): PspUnavailableError {
  return new PspUnavailableError(`the PSP did not give an answer (${reason}), so retry with the same idempotency key`)
}
