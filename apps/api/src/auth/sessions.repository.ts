import { firstRow, type Queryable } from '@carwash/pg'
import type { ApiClientIdentity } from './api-keys.ts'

export interface SessionRow {
  id: string
  name: string
  created_at: Date
  expires_at: Date
}

export async function findSessionClient(db: Queryable, tokenHash: Buffer): Promise<ApiClientIdentity | undefined> {
  const { rows } = await db.query<ApiClientIdentity>(
    `SELECT c.id::text, c.scope::text, s.id::text AS session
       FROM dashboard_sessions s
       JOIN api_clients c ON c.id = s.client_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND c.revoked_at IS NULL AND c.scope = 'admin'`,
    [tokenHash],
  )
  return rows[0]
}

export async function openSession(db: Queryable, clientId: string, tokenHash: Buffer, hours: number): Promise<SessionRow> {
  return firstRow(
    await db.query<SessionRow>(
      `WITH opened AS (
         INSERT INTO dashboard_sessions (client_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(hours => $3))
         RETURNING id, client_id, created_at, expires_at
       )
       SELECT o.id::text, c.name, o.created_at, o.expires_at FROM opened o JOIN api_clients c ON c.id = o.client_id`,
      [clientId, tokenHash, hours],
    ),
  )
}

export async function findSession(db: Queryable, id: string): Promise<SessionRow> {
  return firstRow(
    await db.query<SessionRow>(
      `SELECT s.id::text, c.name, s.created_at, s.expires_at FROM dashboard_sessions s JOIN api_clients c ON c.id = s.client_id WHERE s.id = $1`,
      [id],
    ),
  )
}

export async function revokeSession(db: Queryable, id: string): Promise<SessionRow> {
  return firstRow(
    await db.query<SessionRow>(
      `UPDATE dashboard_sessions s SET revoked_at = now() FROM api_clients c
        WHERE s.id = $1 AND c.id = s.client_id AND s.revoked_at IS NULL
        RETURNING s.id::text, c.name, s.created_at, s.expires_at`,
      [id],
    ),
  )
}
