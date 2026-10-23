'use client'

import type { AnomalyView } from '@carwash/contracts'
import { useRouter } from 'next/navigation'
import { merchantName } from '@/lib/accounts'
import { money } from '@/lib/money'
import { postJson, refusal, useAction } from '@/lib/use-action'

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
}

function describe(a: AnomalyView): string {
  if (!a.attempt) return a.kind.replaceAll('_', ' ')
  const asked = money(a.attempt.amount, a.attempt.currency)
  const where = a.merchant ? ` at ${merchantName(a.merchant)}` : ''
  if (a.resolution === 'accepted') return `A ${a.attempt.kind}${where}, posted at the bank's ${money(a.attempt.amount, a.attempt.currency)}.`
  if (a.kind === 'answer_mismatch' && a.bank_amount)
    return `A ${a.attempt.kind} of ${asked}${where}: the bank says ${money(a.bank_amount, a.attempt.currency)}.`
  return `A ${a.attempt.kind} of ${asked}${where}: ${a.kind.replaceAll('_', ' ')}.`
}

export function AnomaliesPanel({ open, resolved }: { open: AnomalyView[]; resolved: AnomalyView[] }) {
  const router = useRouter()
  const { busy, note, run } = useAction<string>()

  function act(id: string, action: 'accept' | 'dispute') {
    run(`${id}:${action}`, async () => {
      const answer = await postJson(`/api/admin/anomalies/${id}/${action}`)
      router.refresh()
      return refusal(answer)
    })
  }

  return (
    <section className="space-y-4" aria-labelledby="anomalies-title">
      <div className="space-y-1">
        <h2 id="anomalies-title" className="text-xl font-semibold tracking-tight">
          Anomalies
        </h2>
        <p className="text-sm text-muted">
          Answers from the bank the API refused to apply. Accepting one pulls the operation from the bank again, takes its amount and posts it through the
          normal path. Disputing one records the decision and moves no money.
        </p>
      </div>
      {note ? <p className="text-sm text-warn">{note}</p> : null}
      {open.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">Nothing is waiting for a person.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {open.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm">{describe(a)}</p>
                <p className="text-xs text-muted">
                  {when(a.created_at)} UTC · anomaly {a.id}
                </p>
              </div>
              <div className="flex gap-2">
                {a.acceptable ? (
                  <button
                    type="button"
                    onClick={() => act(a.id, 'accept')}
                    disabled={busy !== null}
                    className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50 dark:text-bg"
                  >
                    {busy === `${a.id}:accept` ? 'Accepting…' : "Accept the bank's amount"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => act(a.id, 'dispute')}
                  disabled={busy !== null}
                  className="rounded-lg border border-line bg-bg px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                >
                  {busy === `${a.id}:dispute` ? 'Disputing…' : 'Dispute'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {resolved.length > 0 ? (
        <details className="rounded-xl border border-line bg-surface p-4 text-sm">
          <summary className="cursor-pointer text-muted">Resolved ({resolved.length})</summary>
          <ul className="mt-3 space-y-2">
            {resolved.map((a) => (
              <li key={a.id} className="text-xs">
                <span className={a.resolution === 'accepted' ? 'text-ok' : 'text-warn'}>{a.resolution}</span> · {describe(a)}{' '}
                {a.resolved_at ? (
                  <span className="text-muted">
                    by {a.resolved_by} on {when(a.resolved_at)} UTC
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}
