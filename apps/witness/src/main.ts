import { once } from 'node:events'
import { ORIGIN } from '@carwash/audit'
import { nonNegativeInteger, optional, required } from '@carwash/env'
import { createWitnessServer } from './server.ts'
import { Witness } from './witness.ts'

const env = process.env
const token = required(env, 'WITNESS_TOKEN')
const port = nonNegativeInteger(env, 'WITNESS_PORT', 3145)
const witness = new Witness(optional(env, 'WITNESS_DIR') ?? '/var/lib/witness', optional(env, 'WITNESS_ORIGIN') ?? ORIGIN)
const server = createWitnessServer(witness, token)
server.listen(port, '0.0.0.0')
await once(server, 'listening')
process.stderr.write(`witness listening with key ${witness.publicKey}, last signed size ${witness.latest()?.size ?? 'none'}\n`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
