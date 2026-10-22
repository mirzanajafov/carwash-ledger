import { createPool } from '@carwash/pg'
import { generateApiKey, hashApiKey } from '../auth/api-keys.ts'
import { insertClient } from '../auth/clients.repository.ts'

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
const pool = createPool({ connectionString, max: 1 })
try {
  const id = await insertClient(pool, { name, keyHash: hashApiKey(key), scope })
  process.stdout.write(`client ${id} (${scope}): ${key}\n`)
} finally {
  await pool.end()
}
