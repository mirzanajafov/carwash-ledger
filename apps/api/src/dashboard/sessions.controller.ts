import { Controller, Delete, Get, HttpCode, Inject, Post, Req } from '@nestjs/common'
import { AdminOnly, type AuthedRequest } from '../auth/access.guard.ts'
import { generateSessionToken, hashApiKey } from '../auth/api-keys.ts'
import { findSession, openSession, revokeSession, type SessionRow } from '../auth/sessions.repository.ts'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { ApiError } from '../http/api-error.ts'

function view(row: SessionRow) {
  return { object: 'session', id: row.id, client: row.name, created_at: row.created_at.toISOString(), expires_at: row.expires_at.toISOString() }
}

@AdminOnly()
@Controller('v1/admin/sessions')
export class SessionsController {
  readonly #db: Database
  readonly #config: ApiConfig

  constructor(db: Database, @Inject(API_CONFIG) config: ApiConfig) {
    this.#db = db
    this.#config = config
  }

  @Post()
  @HttpCode(201)
  async open(@Req() request: AuthedRequest) {
    if (request.client.session) throw new ApiError(403, 'forbidden', 'a session cannot open another session, so log in with the key')
    const token = generateSessionToken()
    const opened = await openSession(this.#db.pool, request.client.id, hashApiKey(token), this.#config.sessionHours)
    return { ...view(opened), token }
  }

  @Get('current')
  async current(@Req() request: AuthedRequest) {
    const row = await this.#find(request)
    return view(row)
  }

  @Delete('current')
  async close(@Req() request: AuthedRequest) {
    const session = await this.#find(request)
    return { ...view(await revokeSession(this.#db.pool, session.id)), revoked: true }
  }

  async #find(request: AuthedRequest): Promise<SessionRow> {
    if (!request.client.session) throw new ApiError(404, 'not_a_session', 'this request was made with a key, not a session')
    return findSession(this.#db.pool, request.client.session)
  }
}
