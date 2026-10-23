import { AuditHeadView, CheckpointList } from '@carwash/contracts'
import type { Metadata } from 'next'
import { AuditPanel } from '@/components/audit-panel'
import { callApi, clientKey, witnessKey } from '@/lib/server'

export const metadata: Metadata = { title: 'Audit log · Car Wash Ledger' }
export const dynamic = 'force-dynamic'

async function load() {
  try {
    const [head, checkpoints, key] = await Promise.all([
      callApi('GET', '/v1/audit/head', clientKey()),
      callApi('GET', '/v1/audit/checkpoints', clientKey()),
      witnessKey(),
    ])
    return {
      size: head.status === 200 ? AuditHeadView.parse(head.body).tree_size : null,
      checkpoints: checkpoints.status === 200 ? CheckpointList.parse(checkpoints.body).data.slice(0, 6) : [],
      key,
    }
  } catch {
    return { size: null, checkpoints: [], key: null }
  }
}

export default async function AuditPage() {
  const { size, checkpoints, key } = await load()
  return (
    <div className="space-y-10">
      <div className="max-w-2xl space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Change history, get caught.</h1>
        <p className="text-muted">
          Every journal becomes a leaf in a Merkle tree. A witness that lives outside the database signs the tree&apos;s root every few seconds, and only after
          checking that the new tree extends the old one. Edit the books behind the ledger&apos;s back and the roots stop matching.
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Leaves in the log</p>
          <p className="mt-1 font-mono text-2xl tabular-nums">{size === null ? '—' : size.toLocaleString('en')}</p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Signed by the witness</p>
          <p className="mt-1 font-mono text-2xl tabular-nums">{checkpoints[0] ? checkpoints[0].tree_size.toLocaleString('en') : '—'}</p>
        </div>
        <div className="min-w-0 rounded-xl border border-line bg-surface p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Witness key (Ed25519)</p>
          <p className="mt-1 truncate font-mono text-sm" title={key ?? undefined}>
            {key ?? 'not reachable'}
          </p>
        </div>
      </section>

      {checkpoints.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-base font-semibold">The latest signed checkpoints</h2>
          <ol className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
            {checkpoints.map((c) => (
              <li key={c.tree_size} className="grid grid-cols-[6rem_1fr] gap-3 px-4 py-2 sm:grid-cols-[7rem_1fr_9rem]">
                <span className="font-mono tabular-nums">{c.tree_size.toLocaleString('en')}</span>
                <span className="truncate font-mono text-xs leading-5 text-muted">{c.root}</span>
                <span className="hidden text-right text-xs leading-5 text-muted sm:block">{new Date(c.signed_at).toLocaleTimeString('en-GB')}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <AuditPanel />
    </div>
  )
}
