import type { Metadata } from 'next'
import { PlugPanel } from '@/components/plug-panel'
import { WeatherPanel } from '@/components/weather-panel'

export const metadata: Metadata = { title: 'Pull the plug · Car Wash Ledger' }

export default function PlugPage() {
  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Pull the plug.</h1>
        <p className="text-muted">
          Pick a moment in the middle of a payment. The API arms that point, takes a payment, and kills itself with SIGKILL when it gets there: no
          cleanup, no goodbye. The terminal does what a real one would do and retries with the same idempotency key until it gets an answer. Then the
          invariant checker reads the books.
        </p>
      </div>
      <PlugPanel />
      <hr className="border-line" />
      <WeatherPanel />
    </div>
  )
}
