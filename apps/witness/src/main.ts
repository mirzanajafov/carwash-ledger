import { once } from 'node:events'
import { ORIGIN } from '@carwash/audit'
import { integer, optional, required } from '@carwash/env'
import { createWitnessServer } from './server.ts'
import { Witness } from './witness.ts'

const env = process.env
const witness = new Witness(optional(env, 'WITNESS_DIR') ?? '/var/lib/witness', optional(env, 'WITNESS_ORIGIN') ?? ORIGIN)
const server = createWitnessServer(witness, required(env, 'WITNESS_TOKEN'))
server.listen(integer(env, 'WITNESS_PORT', 3145), '0.0.0.0')
await once(server, 'listening')
process.stderr.write(`witness listening with key ${witness.publicKey}, last signed size ${witness.latest()?.size ?? 'none'}\n`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
