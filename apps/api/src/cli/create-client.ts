import { firstRow } from '@carwash/pg'
import pg from 'pg'
import { generateApiKey, hashApiKey } from '../auth/api-keys.ts'

const [name, scope] = process.argv.slice(2)
if (!name || (scope !== 'client' && scope !== 'admin')) {
  process.stderr.write('usage: create-client <name> <client|admin>   (DATABASE_URL must be the owner role)\n')
  process.exit(2)
}
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  process.stderr.write('DATABASE_URL is required\n')
  process.exit(2)
}

const key = generateApiKey(scope)
const client = new pg.Client({ connectionString })
await client.connect()
try {
  const { id } = firstRow(
    await client.query<{ id: string }>('INSERT INTO api_clients (name, key_hash, scope) VALUES ($1, $2, $3::client_scope) RETURNING id::text', [
      name,
      hashApiKey(key),
      scope,
    ]),
  )
  process.stdout.write(`client ${id} (${scope}): ${key}\n`)
} finally {
  await client.end()
}
