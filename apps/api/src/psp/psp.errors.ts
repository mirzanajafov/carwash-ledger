import { DomainError } from '../domain-errors.ts'

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

export function pspUnavailable(reason: string): PspUnavailableError {
  return new PspUnavailableError(`the PSP did not give an answer (${reason}), so retry with the same idempotency key`)
}
