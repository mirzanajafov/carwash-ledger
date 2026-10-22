import { createPool } from '@carwash/pg'
import { hashApiKey } from '../auth/api-keys.ts'
import { registerClient } from '../auth/clients.repository.ts'

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

const pool = createPool({ connectionString, max: 1 })
try {
  const registered = await registerClient(pool, { name, keyHash: hashApiKey(key), scope })
  process.stdout.write(`${name} (${scope}): ${registered ? 'registered' : 'already registered'}\n`)
} finally {
  await pool.end()
}
