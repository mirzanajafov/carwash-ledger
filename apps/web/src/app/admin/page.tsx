import type { Metadata } from 'next'
import { AdminLogin, AdminLogout } from '@/components/admin-controls'
import { adminSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Admin · Car Wash Ledger' }
export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const session = await adminSession()
  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Admin.</h1>
        <p className="text-muted">
          Visitors share the demo, so the plug, the checks and the bank&apos;s weather each run once in a while for everyone. An admin key opens a session
          that skips those turns and can set the bank&apos;s fault plan by hand. The key is checked once and never kept; the session lives in a cookie this
          site can&apos;t read from a script, ends after 12 hours, on logout, or as soon as the key is revoked.
        </p>
      </div>
      {session ? (
        <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
          <p className="text-sm">
            Logged in as <span className="font-medium">{session.client}</span> until{' '}
            <time dateTime={session.expiresAt} className="tabular-nums">
              {new Date(session.expiresAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC
            </time>
            .
          </p>
          <AdminLogout />
        </div>
      ) : (
        <AdminLogin />
      )}
    </div>
  )
}
