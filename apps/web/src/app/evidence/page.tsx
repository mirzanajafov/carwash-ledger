import type { Metadata } from 'next'
import evidence from '@/data/evidence.json'
import { E1Explorer } from '@/components/e1-explorer'

export const metadata: Metadata = { title: 'Evidence · Car Wash Ledger' }

const MUTANTS: Record<string, string> = {
  M1: 'no unique reference on journals and attempts',
  M2: 'no conditional update on payment state',
  'M1+M2': 'both of the above',
  M3: 'no inbox dedupe in the consumers',
  M4: 'the relay marks events published before producing them',
  M5: 'no request hash check on idempotency keys',
  M6: "no amount check on the bank's answers",
  M7: 'a balance read without its lock and written back (a lost update)',
  M7a: 'only FOR UPDATE dropped from the lock (control)',
  M8: 'webhooks applied as sent instead of pulled',
  M9: 'a snapshot horizon that counts running transactions',
  M10: 'the settlement journal leaves the fee out',
  M11: 'the leaf encoding leaves the reference out',
  M12: 'the checkpointer sends the wrong root',
}

const RECON_CLASSES: [string, string][] = [
  ['missingLine', 'Missing line'],
  ['duplicateLine', 'Duplicate line'],
  ['wrongAmount', 'Wrong amount'],
  ['feeDifference', 'Fee difference'],
  ['nextDay', 'Settles next day'],
  ['droppedReference', 'Dropped reference'],
]

const VARIANTS: Record<string, string> = {
  'pg-cte': 'pg, one CTE',
  'prisma-cte': 'Prisma, one CTE',
  'prisma-sql': 'Prisma, raw statements',
  'prisma-api': 'Prisma query API',
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="max-w-3xl">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted">{note}</p>
      </div>
      {children}
    </section>
  )
}

export default function EvidencePage() {
  const base = evidence.chaos.runs.filter((r) => !r.mutant)
  const order = (id: string) => Number(id.match(/\d+/)?.[0] ?? 0) + (id.includes('+') ? 0.5 : 0) + (/a$/.test(id) ? 0.1 : 0)
  const mutants = evidence.chaos.runs.filter((r) => r.mutant).sort((a, b) => order(a.mutant!) - order(b.mutant!) || a.dir.localeCompare(b.dir))
  const total = (pick: (r: (typeof base)[number]) => number) => base.reduce((sum, r) => sum + pick(r), 0)
  const violations = base.reduce((sum, r) => sum + r.runsWithViolations, 0)
  const e2 = evidence.e2.rows.filter((r) => r.mode === 'locked' && r.concurrency === 1)
  const pending = [
    ...(evidence.e6.trials.length > 0 ? [] : [['Audit log', 'Verifying a million journals, proofs, the sequencer, and a thousand tamper trials per class.']]),
    ...(evidence.e7.rows.length > 0
      ? []
      : [['Schema change', 'Adding a column to 20 million entries under live payments, naive against expand and contract.']]),
    ...(total((r) => r.runs) >= 200 ? [] : [['A long chaos campaign', 'A few hundred runs instead of five, on the final code.']]),
  ]
  return (
    <div className="space-y-14">
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">The numbers behind it.</h1>
        <p className="text-muted">
          Claims about money should come with measurements. These are the chaos campaigns and the benchmarks as they came out, read straight from the result
          files in the repository, including the parts that didn&apos;t go my way.
        </p>
      </div>

      <Section
        title="Chaos"
        note="Payments run while processes are killed with SIGKILL, Postgres and Kafka crash, the network misbehaves and the bank lies. After each run an independent checker reads the books."
      >
        <div className="grid gap-3 sm:grid-cols-4">
          {[
            ['Runs', total((r) => r.runs).toLocaleString('en')],
            ['Journeys and journals', total((r) => r.journeys).toLocaleString('en')],
            ['Kills', total((r) => r.kills + r.postgresKills + r.kafkaKills).toLocaleString('en')],
            ['Runs with a violation', violations.toLocaleString('en')],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-line bg-surface p-4">
              <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
              <p className={`mt-1 font-mono text-2xl tabular-nums ${label === 'Runs with a violation' ? (violations === 0 ? 'text-ok' : 'text-bad') : ''}`}>
                {value}
              </p>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted">
          A zero only means something if the harness can see a violation. So each guard gets a mutant: the same code with that one guard removed. Every one has
          to be caught, except where another guard is meant to cover for it.
        </p>
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Mutant</th>
                <th className="px-2 py-2 font-medium">Guard removed</th>
                <th className="hidden px-2 py-2 font-medium sm:table-cell">Harness</th>
                <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {mutants.map((m) => (
                <tr key={m.dir}>
                  <td className="px-4 py-2 font-mono">{m.mutant}</td>
                  <td className="px-2 py-2 text-muted">
                    {MUTANTS[m.mutant!] ?? ''}
                    <span className={`block text-xs sm:hidden ${m.firstViolatingRun ? 'text-ok' : 'text-warn'}`}>
                      {m.mode}: {m.firstViolatingRun ? `caught in run ${m.firstViolatingRun} by ${m.caughtBy.join(', ')}` : `survived ${m.runs} runs`}
                    </span>
                  </td>
                  <td className="hidden px-2 py-2 text-muted sm:table-cell">{m.mode}</td>
                  <td className={`hidden px-4 py-2 text-right sm:table-cell ${m.firstViolatingRun ? 'text-ok' : 'text-warn'}`}>
                    {m.firstViolatingRun ? `caught in run ${m.firstViolatingRun} by ${m.caughtBy.join(', ')}` : `survived ${m.runs} runs`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">
          M1 survives on purpose: the conditional state update still stops a double capture, and M1 with M2 together is caught at once. M7a is a control: in the
          ledger harness it changes nothing, and in the payments harness S6 still catches the order it gets wrong. The first M6 campaign needed five runs,
          because wrong amounts at 0.2% were too rare to test the guard. At 0.5% it was caught in every run.
        </p>
      </Section>

      <Section
        title="The hot account"
        note="Every payment touches the same fee and receivable accounts, so a plain balance row becomes a lock every payment waits on. Five ways to keep that balance, offered from 50 to 3,200 journals a second, each rate measured for 15 s, three times."
      >
        <E1Explorer points={evidence.e1.points} connections={evidence.e1.connections} />
        <p className="text-sm text-muted">
          A locked row tops out near 150 journals a second, whatever the connection count, because each commit waits for the one before it to flush.
          Serializable is worse at every count. Derived balances and a balance split into 16 rows both sustain about 700 at 32 connections, with p99 under 50
          ms. The ledger uses the 16 rows, because their reads stay cheap.
        </p>
      </Section>

      <Section
        title="The posting path"
        note="One journal of three entries, one connection, the locked mode. The same work through four ways of talking to Postgres."
      >
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[30rem] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">How</th>
                <th className="px-2 py-2 text-right font-medium">Round trips</th>
                <th className="px-2 py-2 text-right font-medium">p50</th>
                <th className="px-2 py-2 text-right font-medium">p99</th>
                <th className="px-4 py-2 text-right font-medium">Journals a second</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {e2.map((r) => (
                <tr key={r.variant}>
                  <td className="px-4 py-2">{VARIANTS[r.variant] ?? r.variant}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{r.roundTrips}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{r.p50.toFixed(1)} ms</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{r.p99.toFixed(1)} ms</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{r.perSecond.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {evidence.e4.steady.length > 0 ? (
        <Section
          title="Outbox lag"
          note="Events are written in the same transaction as the money and a relay publishes them to Kafka. How long that takes on the relay as deployed, at three steady rates (median and range over repeated runs), and what happens when the broker is killed for 30 s at 500 events a second."
        >
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">Events a second</th>
                  <th className="px-2 py-2 text-right font-medium">To Kafka, p50</th>
                  <th className="px-2 py-2 text-right font-medium">To Kafka, p99</th>
                  <th className="px-2 py-2 text-right font-medium">To the consumer, p99</th>
                  <th className="px-4 py-2 text-right font-medium">Transactions an event</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {evidence.e4.steady.map((r) => (
                  <tr key={r.rate}>
                    <td className="px-4 py-2 font-mono tabular-nums">{r.rate.toLocaleString('en')}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{r.ackP50?.median.toFixed(1)} ms</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">
                      {r.ackP99?.median.toFixed(1)} ms{' '}
                      <span className="text-xs text-muted">
                        ({r.ackP99?.min.toFixed(0)}–{r.ackP99?.max.toFixed(0)})
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">
                      {r.consumedP99?.median.toFixed(1)} ms{' '}
                      <span className="text-xs text-muted">
                        ({r.consumedP99?.min.toFixed(0)}–{r.consumedP99?.max.toFixed(0)})
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">{r.transactionsPerEvent?.median.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {evidence.e4.outages.length > 0 ? (
            <ul className="grid gap-2 text-sm sm:grid-cols-3">
              {evidence.e4.outages.map((o, i) => (
                <li key={o.dir} className="rounded-xl border border-line bg-surface p-3">
                  <p className="font-medium">Broker killed, run {i + 1}</p>
                  <p className="text-xs text-muted">
                    Back after {o.kafkaBackS} s, first publish {o.firstPublishS} s later. {o.peakBacklog.toLocaleString('en')} events waited and drained in{' '}
                    {o.drainS} s at {o.drainPerSecond.toLocaleString('en')} a second, and latency was normal again {o.settledS} s after the broker came back.
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {evidence.e6.scale.length > 0 ? (
        <Section
          title="Audit log"
          note="Every committed journal becomes a leaf in a Merkle tree, and a witness outside the database signs its roots. How fast that runs as the log grows, how big a proof is, and whether tampering is caught."
        >
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">Journals</th>
                  <th className="px-2 py-2 text-right font-medium">Sequenced a second</th>
                  <th className="px-2 py-2 text-right font-medium">Full verification</th>
                  <th className="px-2 py-2 text-right font-medium">Proof size</th>
                  <th className="px-4 py-2 text-right font-medium">Bytes a journal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {evidence.e6.scale.map((r) => (
                  <tr key={r.size}>
                    <td className="px-4 py-2 font-mono tabular-nums">{r.size.toLocaleString('en')}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{r.sequencerPerSecond.toLocaleString('en')}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{r.verifyS.toFixed(1)} s</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">
                      {r.proofBytes.min}–{r.proofBytes.max} B
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">{r.auditBytesPerJournal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="max-w-3xl text-sm text-muted">
            {evidence.e6.incremental.length > 0
              ? `Checking only what was added on top of a million: ${evidence.e6.incremental.map((r) => `${r.journals.toLocaleString('en')} journals in ${r.ms.toLocaleString('en')} ms`).join(', ')}. `
              : ''}
            {evidence.e6.lag
              ? `Under ${evidence.e6.lag.rate} payments a second, a journal waited ${evidence.e6.lag.p50.toLocaleString('en')} ms for the sequencer at the median and ${evidence.e6.lag.p99.toLocaleString('en')} ms at p99.`
              : ''}
          </p>
          {evidence.e6.trials.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-line bg-surface">
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2 font-medium">Tampering</th>
                    <th className="px-2 py-2 text-right font-medium">Trials</th>
                    <th className="px-2 py-2 text-right font-medium">Caught</th>
                    <th className="px-2 py-2 text-right font-medium">Right journal named</th>
                    <th className="px-4 py-2 text-right font-medium">Caught without the witness</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {evidence.e6.trials.map((r) => (
                    <tr key={r.key}>
                      <td className="px-4 py-2">{r.key}</td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums">{r.trials}</td>
                      <td className={`px-2 py-2 text-right font-mono tabular-nums ${r.caught === r.trials ? '' : 'text-warn'}`}>{r.caught}</td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums">{r.named}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">{r.caughtWithoutWitness}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Section>
      ) : null}

      {evidence.e7.rows.length > 0 ? (
        <Section
          title="Changing a big table under load"
          note={`Adding a column to ${(evidence.e7.entries / 1e6).toFixed(0)} million entries while 200 payments a second keep coming: one ALTER and UPDATE in a transaction, against expand, backfill in batches, check, validate and contract.`}
        >
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">How</th>
                  <th className="px-2 py-2 text-right font-medium">Took</th>
                  <th className="px-2 py-2 text-right font-medium">Payments meanwhile</th>
                  <th className="px-2 py-2 text-right font-medium">Failed</th>
                  <th className="px-2 py-2 text-right font-medium">p99</th>
                  <th className="px-4 py-2 text-right font-medium">Longest lock wait</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {evidence.e7.rows.map((r) => (
                  <tr key={r.procedure}>
                    <td className="px-4 py-2">{r.procedure === 'naive' ? 'One transaction' : 'Expand and contract'}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{(r.changeS / 60).toFixed(1)} min</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{r.requests.toLocaleString('en')}</td>
                    <td className={`px-2 py-2 text-right font-mono tabular-nums ${r.errors > 0 ? 'text-bad' : ''}`}>
                      {r.errors.toLocaleString('en')} <span className="text-xs text-muted">({((100 * r.errors) / r.requests).toFixed(1)}%)</span>
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">
                      {r.p99 >= 1000 ? `${(r.p99 / 1000).toFixed(1)} s` : `${r.p99.toFixed(1)} ms`}{' '}
                      <span className="text-xs text-muted">(was {r.baselineP99} ms)</span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">{r.longestLockS.toFixed(1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      <Section
        title="Reconciliation"
        note="Settlement files with faults injected at known rates, over three seeds. With references, everything is found. Without them, matching on the amount guesses, and a car wash sells five prices."
      >
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Payments a day</th>
                <th className="px-2 py-2 font-medium">Fallback</th>
                {RECON_CLASSES.map(([key, label]) => (
                  <th key={key} className="px-2 py-2 text-right font-medium">
                    {label}
                  </th>
                ))}
                <th className="px-2 py-2 text-right font-medium">False breaks</th>
                <th className="px-4 py-2 text-right font-medium">No reference: placed wrong</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {evidence.e5.rows.map((r, i) => {
                const placed = r.dropped.right + r.dropped.wrong + r.dropped.unplaced
                return (
                  <tr key={i}>
                    <td className="px-4 py-2 font-mono tabular-nums">{r.perDay.toLocaleString('en')}</td>
                    <td className="px-2 py-2 text-muted">{r.fallback}</td>
                    {RECON_CLASSES.map(([key]) => {
                      const rate = (r.detection as Record<string, number>)[key]
                      return (
                        <td key={key} className={`px-2 py-2 text-right font-mono tabular-nums ${rate === 100 ? '' : 'text-warn'}`}>
                          {rate === undefined ? '—' : `${rate}%`}
                        </td>
                      )
                    })}
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{r.falseBreaks}</td>
                    <td className={`px-4 py-2 text-right font-mono tabular-nums ${r.dropped.wrong > 0 ? 'text-bad' : ''}`}>
                      {placed === 0 ? '—' : `${Math.round((100 * r.dropped.wrong) / placed)}%`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {pending.length > 0 ? (
        <Section title="Still to measure" note="These need a quiet machine and run at night. Their numbers will appear here as they come in.">
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {pending.map(([title, detail]) => (
              <li key={title} className="rounded-xl border border-dashed border-line p-3">
                <p className="font-medium">{title}</p>
                <p className="text-xs text-muted">{detail}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}
