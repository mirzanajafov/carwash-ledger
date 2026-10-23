import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { nonNegativeInteger, positiveInteger } from '@carwash/env'
import { appendJsonLine, createResultsDir, writeJson } from '@carwash/lab'
import type { BalanceMode } from '@carwash/ledger'
import { prepareTemplate } from '@carwash/testkit'
import { describeLedgerRun, runLedger, summarizeLedger, type Lab, type LedgerOptions, type LedgerReport } from './ledger-run.ts'
import { describePaymentsRun, runPayments, summarizePayments, type PaymentsOptions, type PaymentsReport } from './payments/run.ts'
import { LocalKafka } from './kafka.ts'
import { createRoles, LocalPostgres } from './postgres.ts'
import { campaignFailed } from './campaign.ts'
import { Toxiproxy } from './toxiproxy.ts'

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'payments' },
    runs: { type: 'string', default: '5' },
    seed: { type: 'string', default: '1' },
    duration: { type: 'string', default: '60' },
    rate: { type: 'string' },
    merchants: { type: 'string' },
    duplicates: { type: 'string', default: '0.05' },
    'kill-every': { type: 'string', default: '3000' },
    'postgres-every': { type: 'string', default: '20000' },
    'kafka-every': { type: 'string', default: '15000' },
    'toxic-every': { type: 'string', default: '4000' },
    failpoints: { type: 'string' },
    'check-every': { type: 'string', default: '5000' },
    settle: { type: 'string', default: '120' },
    'until-violation': { type: 'boolean', default: false },
    'fail-on-violation': { type: 'boolean', default: false },
    posters: { type: 'string', default: '4' },
    pool: { type: 'string', default: '8' },
    reversals: { type: 'string', default: '0.2' },
    'snapshot-ms': { type: 'string', default: '100' },
    receivable: { type: 'string', default: 'sharded' },
    fees: { type: 'string', default: 'derived' },
    shards: { type: 'string', default: '16' },
    clients: { type: 'string', default: '4' },
    'payout-every': { type: 'string', default: '500' },
    'forge-every': { type: 'string', default: '1000' },
    lease: { type: 'string', default: '5' },
    'psp-timeout': { type: 'string', default: '2000' },
    'psp-faults': { type: 'string', default: '1' },
    out: { type: 'string', default: fileURLToPath(new URL('../results', import.meta.url)) },
  },
})

const mode = values.mode
if (mode !== 'payments' && mode !== 'ledger') throw new Error('--mode is payments or ledger')

const common = {
  durationMs: Number(values.duration) * 1000,
  merchants: Number(values.merchants ?? (mode === 'ledger' ? 20 : 8)),
  duplicateShare: Number(values.duplicates),
  killEveryMs: Number(values['kill-every']),
  postgresEveryMs: Number(values['postgres-every']),
  toxicEveryMs: Number(values['toxic-every']),
  checkEveryMs: Number(values['check-every']),
  settleMs: Number(values.settle) * 1000,
}

const ledgerOptions: LedgerOptions = {
  ...common,
  rate: Number(values.rate ?? 150),
  posters: Number(values.posters),
  pool: positiveInteger({ pool: values.pool }, 'pool', 8),
  reversalShare: Number(values.reversals),
  failpointProbability: Number(values.failpoints ?? 0.001),
  snapshotMs: nonNegativeInteger({ 'snapshot-ms': values['snapshot-ms'] }, 'snapshot-ms', 100),
  receivable: values.receivable as BalanceMode,
  fees: values.fees as BalanceMode,
  shards: Number(values.shards),
}

const pspScale = Number(values['psp-faults'])

const paymentsOptions: PaymentsOptions = {
  ...common,
  rate: Number(values.rate ?? 15),
  clients: Number(values.clients),
  manualShare: 0.3,
  cancelShare: 0.2,
  partialShare: 0.3,
  refundShare: 0.3,
  reuseShare: 0.03,
  rivalShare: 0.1,
  payoutEveryMs: Number(values['payout-every']),
  forgeEveryMs: Number(values['forge-every']),
  kafkaEveryMs: Number(values['kafka-every']),
  failpointProbability: Number(values.failpoints ?? 0.0005),
  leaseSeconds: Number(values.lease),
  pspTimeoutMs: Number(values['psp-timeout']),
  psp: {
    decline: 0.05 * pspScale,
    fail: 0.03 * pspScale,
    timeoutAfterCommit: 0.03 * pspScale,
    slow: 0.03 * pspScale,
    wrongAmount: 0.005 * pspScale,
    webhook: { duplicate: 0.05 * pspScale, delay: 0.02 * pspScale, reorder: 0.05 * pspScale, drop: 0.05 * pspScale },
  },
}

const runs = Number(values.runs)
const firstSeed = Number(values.seed)
const mutant = process.env.MUTANT ?? ''
const POSTGRES_PORT = 5432

async function main(): Promise<void> {
  const dir = createResultsDir(values.out, mutant)
  const logStream = createWriteStream(join(dir, 'harness.log'), { flags: 'a' })
  const postgres = new LocalPostgres('/tmp/pgdata', POSTGRES_PORT, join(dir, 'postgres.log'))
  const toxiproxy = new Toxiproxy()
  const kafka = new LocalKafka('/tmp/kafka', { proxied: 9092, direct: 9094, controller: 9093, advertisedProxied: 6450 })
  const lab: Lab = { dir, postgres, kafka, toxiproxy, log: (line) => logStream.write(`${new Date().toISOString()} ${line}\n`) }
  postgres.init()
  postgres.start()
  await postgres.waitReady()
  await createRoles(postgres.adminUrl)
  await prepareTemplate()
  toxiproxy.start()
  await toxiproxy.waitReady()

  writeJson(join(dir, 'run.json'), {
    commit: process.env.GIT_COMMIT ?? 'unknown',
    mutant: mutant === '' ? null : mutant,
    node: process.version,
    mode,
    runs,
    seed: firstSeed,
    options: mode === 'ledger' ? ledgerOptions : paymentsOptions,
  })
  console.log(`writing to ${dir}, mode ${mode}${mutant === '' ? '' : `, mutant ${mutant}`}`)
  const ledgerReports: LedgerReport[] = []
  const paymentsReports: PaymentsReport[] = []
  try {
    for (let i = 0; i < runs; i++) {
      const seed = firstSeed + i
      const report = mode === 'ledger' ? await runLedger(lab, ledgerOptions, seed) : await runPayments(lab, paymentsOptions, seed)
      appendJsonLine(join(dir, 'runs.jsonl'), report)
      if (mode === 'ledger') {
        ledgerReports.push(report as LedgerReport)
        console.log(describeLedgerRun(i + 1, report as LedgerReport))
      } else {
        paymentsReports.push(report as PaymentsReport)
        console.log(describePaymentsRun(i + 1, report as PaymentsReport))
      }
      for (const v of report.violations) for (const example of v.examples) console.log(`  ${v.id}: ${example}`)
      for (const error of report.harnessErrors.slice(0, 5)) console.log(`  harness: ${error.split('\n')[0] ?? error}`)
      if (report.harnessErrors.length > 5) console.log(`  harness: and ${report.harnessErrors.length - 5} more in runs.jsonl`)
      if (values['until-violation'] && report.violations.length > 0) break
    }
  } finally {
    await kafka.stop()
    toxiproxy.stop()
    await postgres.stop()
    logStream.end()
    await finished(logStream)
  }
  const summary = {
    mode,
    mutant: mutant === '' ? null : mutant,
    ...(mode === 'ledger' ? summarizeLedger(ledgerReports) : summarizePayments(paymentsReports)),
  }
  writeJson(join(dir, 'summary.json'), summary)
  console.log(JSON.stringify(summary, null, 2))
  if (values['fail-on-violation'] && campaignFailed(summary)) process.exitCode = 1
}

await main()
