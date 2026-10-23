'use client'

import { BOOKS } from '@/lib/accounts'
import { totals } from '@/lib/live'
import { money } from '@/lib/money'
import { useLive } from '@/lib/use-live'
import { useNow } from '@/lib/use-now'
import { Bays } from './bays'
import { JournalList } from './journal-list'
import { Mark } from './mark'
import { TAccount } from './t-account'

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted">{note}</p>
      </div>
      {children}
    </section>
  )
}

export function LiveBoard() {
  const { state, connection } = useLive()
  const now = useNow()
  const { books, net } = totals(state.balances)
  const shown = BOOKS.filter((book) => book.key !== 'suspense' || (books.get('suspense')?.amount ?? 0n) !== 0n)
  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <span className="inline-flex items-center gap-2">
          <span className={`size-2 rounded-full ${connection === 'live' ? 'bg-ok' : 'bg-warn animate-pulse'}`} aria-hidden />
          {connection === 'live' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
        </span>
        {state.balances.length > 0 ? (
          <span className={`inline-flex items-center gap-1.5 ${net === 0n ? 'text-ok' : 'text-bad'}`}>
            <Mark ok={net === 0n} />
            {net === 0n ? 'Debits equal credits' : `Off by ${money(net)}`}
          </span>
        ) : null}
        {state.updatedAt ? <span className="text-muted">updated {Math.max(0, Math.round((now - state.updatedAt) / 1000))}s ago</span> : null}
      </div>

      <Section title="Wash bays" note="Payments from the last minute, as the bank answers them.">
        <Bays payments={state.payments} now={now} />
      </Section>

      <Section title="The books" note="Every journal moves money between these accounts. Debits on the left, credits on the right.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((book) => (
            <TAccount key={book.key} book={book} total={books.get(book.key)} postings={state.postings[book.key] ?? []} fresh={state.fresh[book.key]} />
          ))}
        </div>
      </Section>

      <Section title="Journal" note="The latest postings. Each one sums to zero, or the database refuses it.">
        <JournalList journals={state.journals} now={now} />
      </Section>
    </div>
  )
}
