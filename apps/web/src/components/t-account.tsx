import { journalKind, merchantName, type Book } from '@/lib/accounts'
import type { BookTotal, Posting } from '@/lib/live'
import { money } from '@/lib/money'

function Column({ side, postings }: { side: 'debit' | 'credit'; postings: readonly Posting[] }) {
  const mine = postings.filter((p) => p.side === side)
  return (
    <ul className={`min-h-24 space-y-1 py-2 ${side === 'debit' ? 'pr-3' : 'pl-3'}`}>
      {mine.length === 0 ? <li className="text-xs text-muted/70">·</li> : null}
      {mine.map((p) => (
        <li key={`${p.journal}:${p.side}`} className="arrive flex items-baseline justify-between gap-2 text-xs">
          <span className="truncate text-muted">{journalKind(p.ref)}</span>
          <span className={`font-mono tabular-nums ${side === 'debit' ? 'text-debit' : 'text-credit'}`}>{money(p.amount)}</span>
        </li>
      ))}
    </ul>
  )
}

export function TAccount({
  book,
  total,
  postings,
  fresh,
}: {
  book: Book
  total: BookTotal | undefined
  postings: readonly Posting[]
  fresh: number | undefined
}) {
  const amount = total?.amount ?? 0n
  const shown = book.normal === 'debit' ? amount : -amount
  const side = shown < 0n ? (book.normal === 'debit' ? 'Cr' : 'Dr') : book.normal === 'debit' ? 'Dr' : 'Cr'
  return (
    <article key={fresh} className={`rounded-xl border border-line bg-surface p-4 ${fresh ? 'flash' : ''}`}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{book.title}</h3>
          <p className="truncate text-xs text-muted">{book.note}</p>
        </div>
        <p className="shrink-0 text-right">
          <span className="font-mono text-lg tabular-nums">{money(shown < 0n ? -shown : shown)}</span>
          <span className="ml-1 text-xs text-muted">{side}</span>
        </p>
      </header>
      <div className="mt-3 border-t-2 border-ink/70">
        <div className="grid grid-cols-2">
          <div className="border-r-2 border-ink/70">
            <p className="pt-1 text-[10px] font-medium uppercase tracking-wider text-muted">Debit</p>
            <Column side="debit" postings={postings} />
          </div>
          <div>
            <p className="pt-1 pl-3 text-[10px] font-medium uppercase tracking-wider text-muted">Credit</p>
            <Column side="credit" postings={postings} />
          </div>
        </div>
      </div>
      {book.key === 'payables' && total && total.accounts.length > 0 ? (
        <ul className="mt-2 space-y-0.5 border-t border-line pt-2">
          {total.accounts.map((account) => (
            <li key={account.code} className="flex justify-between text-xs">
              <span className="text-muted">{merchantName(account.code)}</span>
              <span className="font-mono tabular-nums">{money(-account.amount)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}
