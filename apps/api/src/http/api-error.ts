import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common'
import type { Response } from 'express'
import { databaseUnavailable } from '../db/unavailable.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly headers: Record<string, string>

  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
    this.headers = headers
  }
}

export function notFound(what: string): ApiError {
  return new ApiError(404, 'not_found', `${what} does not exist`)
}

function httpExceptionMessage(exception: HttpException): string {
  const response = exception.getResponse()
  if (typeof response === 'string') return response
  const message = (response as { message?: unknown }).message
  if (Array.isArray(message)) return message.join('; ')
  return typeof message === 'string' ? message : exception.message
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  readonly #logger = new Logger('api')

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    if (response.headersSent) return
    let status = 500
    let code = 'internal_error'
    let message = 'internal error'
    if (exception instanceof ApiError) {
      status = exception.status
      code = exception.code
      message = exception.message
      for (const [name, value] of Object.entries(exception.headers)) response.setHeader(name, value)
    } else if (exception instanceof HttpException) {
      status = exception.getStatus()
      code = status === 400 ? 'invalid_request' : status === 404 ? 'not_found' : `http_${status}`
      message = httpExceptionMessage(exception)
    } else if (databaseUnavailable(exception)) {
      status = 503
      code = 'database_unavailable'
      message = 'the database could not be reached; retry with the same idempotency key'
      response.setHeader('Retry-After', '1')
      this.#logger.warn(`database unavailable: ${(exception as Error).message}`)
    } else {
      this.#logger.error((exception as Error)?.stack ?? String(exception))
    }
    response.status(status).json({ error: { code, message } })
  }
}
