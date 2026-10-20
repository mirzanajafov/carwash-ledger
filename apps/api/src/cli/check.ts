import { checkAudit, checkLedger, checkPayments, readWitness, violations } from '@carwash/invariants'
import { createPool } from '@carwash/pg'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  process.stderr.write('usage: check   (DATABASE_URL, ideally the ledger_audit role, and optionally WITNESS_URL to check S7 against the witness)\n')
  process.exit(2)
}

const pool = createPool({ connectionString, max: 2 })
try {
  const witness = process.env.WITNESS_URL ? await readWitness(process.env.WITNESS_URL) : undefined
  const results = [...(await checkLedger(pool)), ...(await checkPayments(pool)), await checkAudit(pool, witness)]
  for (const result of results)
    process.stdout.write(
      `${result.id} ${result.count === 0 ? 'holds' : `BROKEN ${result.count}`}  ${result.description}\n${result.examples.map((e) => `    ${e}\n`).join('')}`,
    )
  process.exitCode = violations(results).length === 0 ? 0 : 1
} finally {
  await pool.end()
}
