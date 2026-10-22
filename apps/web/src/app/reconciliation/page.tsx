import type { Metadata } from 'next'
import Link from 'next/link'
import { money } from '@/lib/money'
import { adminKey, callApi } from '@/lib/server'

export const metadata: Metadata = { title: 'Reconciliation · Car Wash Ledger' }
export const dynamic = 'force-dynamic'

interface Day {
  day: number
  id: string
  lines: number
  gross: string
  fee: string
  net: string
  journal_id: string | null
  received_at: string
  breaks: Record<string, number>
}

interface Line {
  line: number
  operation: string
  reference: string
  kind: string
  gross: string
  fee: string
  net: string
  break: string | null
}

interface Break {
  class: string
  line: number | null
  journal_ref: string | null
  detail: string
}

const CLASSES: Record<string, string> = {
  missing_line: 'in the books, not in the file',
  unknown_line: 'in the file, not in the books',
  duplicate_line: 'the file lists it twice',
  wrong_amount: 'the amounts differ',
  fee_difference: 'the fee is not the contract fee',
}

function when(day: number, daySeconds: number | null): string {
  if (!daySeconds) return `day ${day}`
  const start = new Date(day * daySeconds * 1000)
  return daySeconds >= 86_400
    ? start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : start.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

async function load(requested: number | null) {
  const days = await callApi('GET', '/v1/reconciliation/days?limit=14', adminKey())
  if (days.status !== 200) return { error: days.body?.error?.message ?? `the API answered ${days.status}` }
  const list = days.body.data as Day[]
  const pick = requested ?? list[0]?.day ?? null
  const detail = pick === null ? null : await callApi('GET', `/v1/reconciliation/days/${pick}`, adminKey())
  return {
    list,
    daySeconds: days.body.day_seconds as number | null,
    pick,
    detail: detail?.status === 200 ? (detail.body as { file: Day | null; lines: Line[]; breaks: Break[] }) : null,
  }
}

export default async function ReconciliationPage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const { day } = await searchParams
  const data = await load(day && /^\d{1,12}$/.test(day) ? Number(day) : null).catch(() => ({ error: 'the ledger API is not answering' }))
  return (
    <div className="space-y-10">
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">The bank&apos;s file against the books.</h1>
        <p className="text-muted">
          At the end of each day the payment provider sends a settlement file: every capture and refund it settled, with its fee. The matcher pairs each line
          with the ledger by reference. Whatever doesn&apos;t pair is a break, and a person looks at it. In the demo a day is compressed to a few minutes.
        </p>
      </div>

      {'error' in data ? (
        <p className="text-sm text-warn">The page could not load: {data.error}.</p>
      ) : data.list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-muted">No day has closed yet.</p>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Settled days</h2>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
              {data.list.map((d) => {
                const breaks = Object.values(d.breaks).reduce((a, b) => a + b, 0)
                return (
                  <li key={d.day}>
                    <Link
                      href={`/reconciliation?day=${d.day}`}
                      className={`grid grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-2 hover:bg-surface-2 ${d.day === data.pick ? 'bg-surface-2' : ''}`}
                    >
                      <span>{when(d.day, data.daySeconds)}</span>
                      <span className="font-mono tabular-nums text-muted">{d.lines} lines</span>
                      <span className={`w-20 text-right ${breaks === 0 ? 'text-ok' : 'text-warn'}`}>
                        {breaks === 0 ? 'clean' : `${breaks} break${breaks === 1 ? '' : 's'}`}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>

          {data.pick !== null && data.detail?.file ? (
            <section className="space-y-4">
              <h2 className="text-base font-semibold">{when(data.pick, data.daySeconds)}</h2>
              <div className="grid gap-3 sm:grid-cols-4">
                {[
                  ['Gross', money(data.detail.file.gross)],
                  ['PSP fee', money(data.detail.file.fee)],
                  ['Net to the bank', money(data.detail.file.net)],
                  ['Settlement journal', data.detail.file.journal_id ? `#${data.detail.file.journal_id}` : 'none'],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-line bg-surface p-3">
                    <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
                    <p className="mt-1 font-mono text-lg tabular-nums">{value}</p>
                  </div>
                ))}
              </div>

              {data.detail.breaks.length > 0 ? (
                <div className="rounded-xl border border-warn/40 bg-surface">
                  <p className="border-b border-line px-4 py-3 text-sm font-medium text-warn">Breaks for a person to look at</p>
                  <ul className="divide-y divide-line text-sm">
                    {data.detail.breaks.map((b, i) => (
                      <li key={i} className="grid gap-1 px-4 py-2 sm:grid-cols-[11rem_1fr]">
                        <span>
                          <span className="font-medium">{b.class.replace('_', ' ')}</span>
                          <span className="block text-xs text-muted">{CLASSES[b.class] ?? ''}</span>
                        </span>
                        <span className="font-mono text-xs leading-5 text-muted">{b.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-ok">
                  {data.detail.file.lines === 0
                    ? 'Nothing settled that day, and the books agree.'
                    : 'Every line paired with the books, and every capture and refund of the day is in the file.'}
                </p>
              )}

              {data.detail.lines.length === 0 ? null : (
                <div className="overflow-x-auto rounded-xl border border-line bg-surface">
                  <table className="w-full min-w-[34rem] text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-muted">
                      <tr className="border-b border-line">
                        <th className="px-4 py-2 font-medium">Line</th>
                        <th className="px-2 py-2 font-medium">Kind</th>
                        <th className="px-2 py-2 font-medium">Reference</th>
                        <th className="px-2 py-2 text-right font-medium">Gross</th>
                        <th className="px-2 py-2 text-right font-medium">Fee</th>
                        <th className="px-4 py-2 text-right font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {data.detail.lines.map((l) => (
                        <tr key={l.line}>
                          <td className="px-4 py-1.5 font-mono tabular-nums text-muted">{l.line}</td>
                          <td className="px-2 py-1.5">{l.kind}</td>
                          <td className="max-w-40 truncate px-2 py-1.5 font-mono text-xs text-muted">{l.reference || '—'}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums">{money(l.gross)}</td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted">{money(l.fee)}</td>
                          <td className={`px-4 py-1.5 text-right text-xs ${l.break ? 'text-warn' : 'text-ok'}`}>
                            {l.break ? l.break.replace('_', ' ') : 'matched'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {data.detail.file.lines > data.detail.lines.length ? (
                <p className="text-xs text-muted">
                  Showing {data.detail.lines.length} of {data.detail.file.lines} lines, breaks first.
                </p>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
