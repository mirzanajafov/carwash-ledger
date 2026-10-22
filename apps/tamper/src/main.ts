import { once } from 'node:events'
import { createPool } from '@carwash/pg'
import { createTamperServer } from './server.ts'
import { TamperService } from './service.ts'

const connectionString = process.env.TAMPER_DATABASE_URL
const token = process.env.TAMPER_TOKEN
if (!connectionString) throw new Error('TAMPER_DATABASE_URL is required')
if (!token) throw new Error('TAMPER_TOKEN is required')
const pool = createPool({ connectionString, max: 2 })
const service = new TamperService(pool, { autoRestoreMs: Number(process.env.TAMPER_AUTO_RESTORE_SECONDS ?? 0) * 1000 })
const stop = new AbortController()
const restoring = service.restoreWhenDue(stop.signal)
const server = createTamperServer(service, token)
server.listen(Number(process.env.TAMPER_PORT ?? 3146), '0.0.0.0')
await once(server, 'listening')
process.stderr.write('tamper service listening\n')
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stop.abort()
    server.close(() => void restoring.then(() => pool.end()).finally(() => process.exit(0)))
  })
}
