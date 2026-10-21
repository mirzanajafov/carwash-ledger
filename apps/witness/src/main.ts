import { once } from 'node:events'
import { ORIGIN } from '@carwash/audit'
import { createWitnessServer } from './server.ts'
import { Witness } from './witness.ts'

const token = process.env.WITNESS_TOKEN
if (!token) throw new Error('WITNESS_TOKEN is required')
const witness = new Witness(process.env.WITNESS_DIR ?? '/var/lib/witness', process.env.WITNESS_ORIGIN ?? ORIGIN)
const server = createWitnessServer(witness, token)
server.listen(Number(process.env.WITNESS_PORT ?? 3145), '0.0.0.0')
await once(server, 'listening')
process.stderr.write(`witness listening with key ${witness.publicKey}, last signed size ${witness.latest()?.size ?? 'none'}\n`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
