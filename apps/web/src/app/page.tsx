import { LiveBoard } from '@/components/live-board'

export default function LivePage() {
  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Every cent, exactly once.</h1>
        <p className="text-muted">
          A ledger for a chain of car washes. Customers pay at the bay, the payment provider answers, and every euro lands in double-entry books
          that the database refuses to unbalance. This page follows it as it happens.
        </p>
      </div>
      <LiveBoard />
    </div>
  )
}
