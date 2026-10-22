import { Controller, Delete, Get, HttpCode, Inject, Post, Req } from '@nestjs/common'
import { firstRow } from '@carwash/pg'
import { AdminOnly, type AuthedRequest } from '../auth/access.guard.ts'
import { generateSessionToken, hashApiKey } from '../auth/api-keys.ts'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { Database } from '../db/database.ts'
import { ApiError } from '../http/api-error.ts'

interface SessionRow {
  id: string
  name: string
  created_at: Date
  expires_at: Date
}

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
    const opened = await this.#db.pool.query<SessionRow>(
      `WITH opened AS (
         INSERT INTO dashboard_sessions (client_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(hours => $3))
         RETURNING id, client_id, created_at, expires_at
       )
       SELECT o.id::text, c.name, o.created_at, o.expires_at FROM opened o JOIN api_clients c ON c.id = o.client_id`,
      [request.client.id, hashApiKey(token), this.#config.sessionHours],
    )
    return { ...view(firstRow(opened)), token }
  }

  @Get('current')
  async current(@Req() request: AuthedRequest) {
    const row = await this.#find(request)
    return view(row)
  }

  @Delete('current')
  async close(@Req() request: AuthedRequest) {
    await this.#find(request)
    const revoked = await this.#db.pool.query<SessionRow>(
      `UPDATE dashboard_sessions s SET revoked_at = now() FROM api_clients c
        WHERE s.id = $1 AND c.id = s.client_id AND s.revoked_at IS NULL
        RETURNING s.id::text, c.name, s.created_at, s.expires_at`,
      [request.client.session],
    )
    return { ...view(firstRow(revoked)), revoked: true }
  }

  async #find(request: AuthedRequest): Promise<SessionRow> {
    if (!request.client.session) throw new ApiError(404, 'not_a_session', 'this request was made with a key, not a session')
    const found = await this.#db.pool.query<SessionRow>(
      `SELECT s.id::text, c.name, s.created_at, s.expires_at FROM dashboard_sessions s JOIN api_clients c ON c.id = s.client_id WHERE s.id = $1`,
      [request.client.session],
    )
    return firstRow(found)
  }
}
