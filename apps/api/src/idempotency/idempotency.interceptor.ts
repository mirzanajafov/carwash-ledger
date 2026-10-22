import { createParamDecorator, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common'
import type { Response } from 'express'
import { map, type Observable } from 'rxjs'
import type { AuthedRequest } from '../auth/access.guard.ts'
import type { KeyedRequest, Reply } from './idempotency.service.ts'

export const Keyed = createParamDecorator((_: unknown, context: ExecutionContext): KeyedRequest => {
  const request = context.switchToHttp().getRequest<AuthedRequest>()
  return { clientId: request.client.id, key: request.headers['idempotency-key'], method: request.method, path: request.path, body: request.body ?? {} }
})

@Injectable()
export class ReplyInterceptor implements NestInterceptor<Reply, unknown> {
  intercept(context: ExecutionContext, next: CallHandler<Reply>): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>()
    return next.handle().pipe(
      map((reply) => {
        if (reply.replayed) response.setHeader('Idempotent-Replayed', 'true')
        response.status(reply.status)
        return reply.body
      }),
    )
  }
}
