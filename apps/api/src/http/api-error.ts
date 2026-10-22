export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterSeconds: number | undefined

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}
