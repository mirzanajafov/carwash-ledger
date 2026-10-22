import { createParamDecorator, HttpException, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common'
import type { Response } from 'express'
import { catchError, map, of, type Observable } from 'rxjs'
import type { AuthedRequest } from '../auth/access.guard.ts'
import { DomainError, invalidInput } from '../domain-errors.ts'
import { IdempotencyService, type Final, type OwnedKey } from './idempotency.service.ts'

type IdempotentRequest = AuthedRequest & { idempotency?: OwnedKey }

function refused(error: unknown): boolean {
  if (error instanceof DomainError) return error.refusal
  return error instanceof HttpException && error.getStatus() < 500
}

export const Owned = createParamDecorator((_: unknown, context: ExecutionContext): OwnedKey => {
  const owned = context.switchToHttp().getRequest<IdempotentRequest>().idempotency
  if (!owned) throw new Error('this route needs the idempotency interceptor')
  return owned
})

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor<Final, unknown> {
  readonly #idempotency: IdempotencyService

  constructor(idempotency: IdempotencyService) {
    this.#idempotency = idempotency
  }

  async intercept(context: ExecutionContext, next: CallHandler<Final>): Promise<Observable<unknown>> {
    const http = context.switchToHttp()
    const request = http.getRequest<IdempotentRequest>()
    const response = http.getResponse<Response>()
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length === 0 || key.length > 255) {
      throw invalidInput('every POST needs an Idempotency-Key header of 1 to 255 characters')
    }
    const begun = await this.#idempotency.begin(request.client.id, key, request.method, request.path, request.body ?? {})
    if (begun.kind === 'replay') {
      response.setHeader('Idempotent-Replayed', 'true')
      response.status(begun.status)
      return of(begun.body)
    }
    request.idempotency = begun.owned
    return next.handle().pipe(
      map((final) => {
        response.status(final.status)
        return final.body
      }),
      catchError((error: unknown) => this.#giveUp(begun.owned, error)),
    )
  }

  async #giveUp(owned: OwnedKey, error: unknown): Promise<never> {
    if (refused(error)) await this.#idempotency.abandon(owned)
    else await this.#idempotency.release(owned).catch(() => undefined)
    throw error
  }
}
