import { once } from 'node:events'
import { nonNegativeInteger, required } from '@carwash/env'
import { createPool } from '@carwash/pg'
import { createTamperServer } from './server.ts'
import { TamperService } from './service.ts'

const env = process.env
const token = required(env, 'TAMPER_TOKEN')
const pool = createPool({ connectionString: required(env, 'TAMPER_DATABASE_URL'), max: 2 })
const service = new TamperService(pool, { autoRestoreMs: nonNegativeInteger(env, 'TAMPER_AUTO_RESTORE_SECONDS', 0) * 1000 })
const stop = new AbortController()
const restoring = service.restoreWhenDue(stop.signal)
const server = createTamperServer(service, token)
server.listen(nonNegativeInteger(env, 'TAMPER_PORT', 3146), '0.0.0.0')
await once(server, 'listening')
process.stderr.write('tamper service listening\n')
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stop.abort()
    server.close(() => void restoring.then(() => pool.end()).finally(() => process.exit(0)))
  })
}
