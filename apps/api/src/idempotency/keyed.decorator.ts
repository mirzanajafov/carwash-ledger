import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { AuthedRequest } from '../auth/access.guard.ts'
import type { KeyedRequest } from './idempotency.service.ts'

export const Keyed = createParamDecorator((_: unknown, context: ExecutionContext): KeyedRequest => {
  const request = context.switchToHttp().getRequest<AuthedRequest>()
  return { clientId: request.client.id, key: request.headers['idempotency-key'], method: request.method, path: request.path, body: request.body ?? {} }
})
