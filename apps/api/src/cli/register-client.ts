import pg from 'pg'
import { hashApiKey } from '../auth/api-keys.ts'

const [name, scope] = process.argv.slice(2)
const key = process.env.CLIENT_KEY
if (!name || (scope !== 'client' && scope !== 'admin') || !key || key.length < 24) {
  process.stderr.write('usage: CLIENT_KEY=<at least 24 characters> register-client <name> <client|admin>   (DATABASE_URL must be the owner role)\n')
  process.exit(2)
}
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  process.stderr.write('DATABASE_URL is required\n')
  process.exit(2)
}

const client = new pg.Client({ connectionString })
await client.connect()
try {
  const { rowCount } = await client.query(
    'INSERT INTO api_clients (name, key_hash, scope) VALUES ($1, $2, $3::client_scope) ON CONFLICT (key_hash) DO NOTHING',
    [name, hashApiKey(key), scope],
  )
  process.stdout.write(`${name} (${scope}): ${rowCount === 1 ? 'registered' : 'already registered'}\n`)
} finally {
  await client.end()
}
