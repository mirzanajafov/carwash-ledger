import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { verifyLog, type VerifierState } from '@carwash/audit-pg'
import { readWitness } from '@carwash/invariants'
import pg from 'pg'

const { values } = parseArgs({
  options: {
    state: { type: 'string' },
    witness: { type: 'string' },
    full: { type: 'boolean', default: false },
    batch: { type: 'string', default: '5000' },
  },
})
const connectionString = process.env.DATABASE_URL
const witnessUrl = (values.witness ?? process.env.WITNESS_URL)?.replace(/\/+$/, '')
if (!connectionString) {
  process.stderr.write('usage: verify [--state file] [--witness url] [--full]   (DATABASE_URL, ideally the ledger_audit role)\n')
  process.exit(2)
}

function loadState(file: string | undefined): VerifierState | undefined {
  if (!file || values.full) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as VerifierState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const witness = witnessUrl ? await readWitness(witnessUrl) : undefined
const client = new pg.Client({ connectionString })
client.on('error', () => undefined)
await client.connect()
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const report = await verifyLog(client, { witness, from: loadState(values.state), batch: Number(values.batch) })
  await client.query('COMMIT')
  process.stdout.write(`${JSON.stringify({ ...report, state: undefined }, null, 2)}\n`)
  if (values.state && report.findings === 0 && report.state) {
    writeFileSync(`${values.state}.next`, JSON.stringify(report.state), { mode: 0o600 })
    renameSync(`${values.state}.next`, values.state)
  }
  process.exitCode = report.findings === 0 ? 0 : 1
} finally {
  await client.end()
}
