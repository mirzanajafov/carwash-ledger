import { bookOf, journalKind, merchantName } from '@/lib/accounts'
import type { Journal } from '@/lib/live'
import { money, since } from '@/lib/money'

function accountLabel(code: string): string {
  if (code.startsWith('merchant_payable:')) return `Payable, ${merchantName(code)}`
  return bookOf(code)?.title ?? code
}

export function JournalList({ journals, now }: { journals: readonly Journal[]; now: number }) {
  if (journals.length === 0) return <p className="text-sm text-muted">Nothing posted yet.</p>
  return (
    <ol className="divide-y divide-line rounded-xl border border-line bg-surface">
      {journals.map((journal) => (
        <li key={journal.id} className="arrive grid gap-2 p-3 sm:grid-cols-[11rem_minmax(0,30rem)]">
          <div className="text-xs">
            <p className="font-medium">
              {journalKind(journal.external_ref)} <span className="font-mono text-muted">#{journal.id}</span>
            </p>
            <p className="text-muted">{since(journal.posted_at, now)}</p>
          </div>
          <table className="w-full text-xs">
            <tbody>
              {journal.entries.map((entry, i) => {
                const amount = BigInt(entry.amount)
                return (
                  <tr key={i}>
                    <td className={`py-0.5 ${amount < 0n ? 'pl-4' : ''} text-muted`}>{accountLabel(entry.account)}</td>
                    <td className="w-24 py-0.5 text-right font-mono tabular-nums text-debit">{amount > 0n ? money(amount) : ''}</td>
                    <td className="w-24 py-0.5 text-right font-mono tabular-nums text-credit">{amount < 0n ? money(-amount) : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </li>
      ))}
    </ol>
  )
}
