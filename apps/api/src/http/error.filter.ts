import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common'
import type { Response } from 'express'
import { databaseUnavailable } from '../db/unavailable.ts'
import { DomainError, type Failure } from '../domain-errors.ts'
import { ApiError } from './api-error.ts'

const STATUS: Record<Failure, number> = { invalid: 400, not_found: 404, conflict: 409, unprocessable: 422, upstream: 502, unavailable: 503 }

interface ErrorReply {
  status: number
  code: string
  message: string
  retryAfterSeconds?: number | undefined
}

function httpExceptionMessage(exception: HttpException): string {
  const response = exception.getResponse()
  if (typeof response === 'string') return response
  const message = (response as { message?: unknown }).message
  if (Array.isArray(message)) return message.join('. ')
  return typeof message === 'string' ? message : exception.message
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  readonly #logger = new Logger('api')

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    if (response.headersSent) return
    const reply = this.#reply(exception)
    if (reply.retryAfterSeconds !== undefined) response.setHeader('Retry-After', String(reply.retryAfterSeconds))
    response.status(reply.status).json({ error: { code: reply.code, message: reply.message } })
  }

  #reply(exception: unknown): ErrorReply {
    if (exception instanceof DomainError) {
      return { status: STATUS[exception.failure], code: exception.code, message: exception.message, retryAfterSeconds: exception.retryAfterSeconds }
    }
    if (exception instanceof ApiError) {
      return { status: exception.status, code: exception.code, message: exception.message, retryAfterSeconds: exception.retryAfterSeconds }
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      return { status, code: status === 400 ? 'invalid_request' : status === 404 ? 'not_found' : `http_${status}`, message: httpExceptionMessage(exception) }
    }
    if (databaseUnavailable(exception)) {
      this.#logger.warn(`database unavailable: ${exception instanceof Error ? exception.message : String(exception)}`)
      return {
        status: 503,
        code: 'database_unavailable',
        message: 'the database could not be reached, so retry with the same idempotency key',
        retryAfterSeconds: 1,
      }
    }
    this.#logger.error(exception instanceof Error ? (exception.stack ?? String(exception)) : String(exception))
    return { status: 500, code: 'internal_error', message: 'internal error' }
  }
}
