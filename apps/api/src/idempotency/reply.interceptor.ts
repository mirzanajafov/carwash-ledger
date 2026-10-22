import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common'
import type { Response } from 'express'
import { map, type Observable } from 'rxjs'
import type { Reply } from './idempotency.service.ts'

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
