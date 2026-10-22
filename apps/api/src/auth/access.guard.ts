import { Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { ApiError } from '../http/api-error.ts'
import { hashApiKey, SESSION_PREFIX, type ApiClientIdentity } from './api-keys.ts'
import { findClientByKey } from './clients.repository.ts'
import { findSessionClient } from './sessions.repository.ts'
import { TokenBuckets } from './token-buckets.ts'

const PUBLIC = 'carwash:public'
const ADMIN_ONLY = 'carwash:admin-only'

export const Public = () => SetMetadata(PUBLIC, true)
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true)

export type AuthedRequest = Request & { client: ApiClientIdentity }

function tooMany(): ApiError {
  return new ApiError(429, 'rate_limited', 'too many requests', { 'retry-after': '1' })
}

@Injectable()
export class AccessGuard implements CanActivate {
  readonly #reflector: Reflector
  readonly #db: Database
  readonly #perIp: TokenBuckets
  readonly #perKey: TokenBuckets

  constructor(reflector: Reflector, db: Database, @Inject(API_CONFIG) config: ApiConfig) {
    this.#reflector = reflector
    this.#db = db
    this.#perIp = new TokenBuckets(config.rateLimitPerIp, config.rateLimitPerIp * 2)
    this.#perKey = new TokenBuckets(config.rateLimitPerKey, config.rateLimitPerKey * 2)
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const targets = [context.getHandler(), context.getClass()]
    if (!this.#perIp.take(request.ip ?? 'unknown')) throw tooMany()
    if (this.#reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true

    const header = request.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) throw new ApiError(401, 'unauthorized', 'an API key is required')
    const token = header.slice(7)
    const hash = hashApiKey(token)
    const client = token.startsWith(SESSION_PREFIX) ? await findSessionClient(this.#db.pool, hash) : await findClientByKey(this.#db.pool, hash)
    if (!client) {
      throw new ApiError(401, 'unauthorized', token.startsWith(SESSION_PREFIX) ? 'the session has ended' : 'the API key is unknown or revoked')
    }
    if (!this.#perKey.take(client.id)) throw tooMany()
    if (this.#reflector.getAllAndOverride<boolean>(ADMIN_ONLY, targets) && client.scope !== 'admin') {
      throw new ApiError(403, 'forbidden', 'this endpoint needs an admin key')
    }
    Object.assign(request, { client })
    return true
  }
}
