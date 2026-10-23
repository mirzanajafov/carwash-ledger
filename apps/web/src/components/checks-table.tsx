import type { InvariantResult } from '@carwash/contracts'
import type { PaymentScope } from '@/lib/plug'

function scopeOf({ since, payments, merchant_entries }: PaymentScope): string {
  const what = `${payments.toLocaleString('en')} payment${payments === 1 ? '' : 's'} and ${merchant_entries.toLocaleString('en')} merchant entr${merchant_entries === 1 ? 'y' : 'ies'}`
  return since === null
    ? `S3 and S6 read all ${what}, because there was no clean run to continue from.`
    : `S3 and S6 looked only at what changed since the clean run of ${new Date(since).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' })}: ${what}.`
}

export function ChecksTable({ results, ms, scope }: { results: readonly InvariantResult[]; ms: number; scope: PaymentScope }) {
  const broken = results.filter((r) => r.count > 0)
  return (
    <div className="rounded-xl border border-line bg-surface">
      <p className={`border-b border-line px-4 py-3 text-sm font-medium ${broken.length === 0 ? 'text-ok' : 'text-bad'}`}>
        {broken.length === 0 ? `All ${results.length} invariants hold` : `${broken.length} of ${results.length} invariants are broken`}
        <span className="ml-2 font-normal text-muted">checked in {ms} ms in a read-only snapshot as the audit role</span>
      </p>
      <p className="border-b border-line px-4 py-2 text-xs text-muted">{scopeOf(scope)}</p>
      <ul className="divide-y divide-line">
        {results.map((result) => (
          <li key={result.id} className="grid grid-cols-[3rem_1fr_auto] items-start gap-3 px-4 py-2 text-sm">
            <span className="font-mono text-muted">{result.id}</span>
            <span>
              {result.description}
              {result.examples.length > 0 ? (
                <ul className="mt-1 space-y-0.5 font-mono text-xs text-bad">
                  {result.examples.map((example) => (
                    <li key={example}>{example}</li>
                  ))}
                </ul>
              ) : null}
            </span>
            <span className={`font-mono tabular-nums ${result.count === 0 ? 'text-ok' : 'text-bad'}`}>{result.count}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
