import type { LivePayment } from '@carwash/contracts'
import { merchantName, programOf } from '@/lib/accounts'
import { money, since } from '@/lib/money'

const REFUNDED = { label: 'Refunded', tone: 'text-violet border-violet/40' }

const STATUS: Record<string, { label: string; tone: string }> = {
  created: { label: 'Started', tone: 'text-muted border-line' },
  authorized: { label: 'Authorized', tone: 'text-warn border-warn/40' },
  captured: { label: 'Paid', tone: 'text-ok border-ok/40' },
  refunded: REFUNDED,
  canceled: { label: 'Canceled', tone: 'text-muted border-line' },
  failed: { label: 'Declined', tone: 'text-bad border-bad/40' },
}

export function Bays({ payments, now }: { payments: readonly LivePayment[]; now: number }) {
  if (payments.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-muted">
        Waiting for the next car. Payments from the last minute show up here.
      </div>
    )
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {payments.map((payment) => {
        const status = STATUS[payment.status] ?? { label: payment.status, tone: 'text-muted border-line' }
        const refunded = BigInt(payment.refunded_amount)
        const partly = payment.status === 'captured' && refunded > 0n
        return (
          <li key={payment.id} className="arrive flex min-h-32 flex-col justify-between rounded-xl border border-line bg-surface p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium uppercase tracking-wide text-muted">{merchantName(payment.merchant)}</p>
                <p className="truncate text-sm font-medium">{programOf(payment.amount)}</p>
              </div>
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${partly ? REFUNDED.tone : status.tone}`}>
                {partly ? 'Part refund' : status.label}
              </span>
            </div>
            <div>
              <p className="font-mono text-xl tabular-nums">{money(payment.amount, payment.currency)}</p>
              <p className="text-xs text-muted">
                {refunded > 0n ? `${money(refunded, payment.currency)} back · ` : ''}
                {since(payment.updated_at, now)}
              </p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
