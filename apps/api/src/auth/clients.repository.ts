import { firstRow, type Queryable } from '@carwash/pg'
import type { ApiClientIdentity, ClientScope } from './api-keys.ts'

export interface NewClient {
  name: string
  keyHash: Buffer
  scope: ClientScope
}

export async function findClientByKey(db: Queryable, keyHash: Buffer): Promise<ApiClientIdentity | undefined> {
  const { rows } = await db.query<ApiClientIdentity>('SELECT id::text, scope::text FROM api_clients WHERE key_hash = $1 AND revoked_at IS NULL', [keyHash])
  return rows[0]
}

export async function insertClient(db: Queryable, client: NewClient): Promise<string> {
  return firstRow(
    await db.query<{ id: string }>('INSERT INTO api_clients (name, key_hash, scope) VALUES ($1, $2, $3::client_scope) RETURNING id::text', [
      client.name,
      client.keyHash,
      client.scope,
    ]),
  ).id
}

export async function registerClient(db: Queryable, client: NewClient): Promise<boolean> {
  const { rowCount } = await db.query('INSERT INTO api_clients (name, key_hash, scope) VALUES ($1, $2, $3::client_scope) ON CONFLICT (key_hash) DO NOTHING', [
    client.name,
    client.keyHash,
    client.scope,
  ])
  return rowCount === 1
}
