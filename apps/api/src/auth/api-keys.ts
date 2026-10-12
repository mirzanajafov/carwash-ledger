import { createHash, randomBytes } from 'node:crypto'

export type ClientScope = 'client' | 'admin'

export interface ApiClientIdentity {
  id: string
  scope: ClientScope
}

export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key).digest()
}

export function generateApiKey(scope: ClientScope): string {
  return `cw_${scope === 'admin' ? 'admin' : 'live'}_${randomBytes(24).toString('base64url')}`
}
