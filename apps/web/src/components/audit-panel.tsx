'use client'

import { errorOf } from '@carwash/contracts'
import { useCallback, useEffect, useReducer, useState } from 'react'
import { AuditState, EMPTY, reduce } from '@/lib/audit'
import { postJson, refusal, useAction } from '@/lib/use-action'
import { isOpen } from '@/lib/verification'
import { checkJournal, JournalEvidence, type Verdict } from '@/lib/verify-journal'
import { Mark as Drawn } from './mark'
import { VerificationRun } from './verification-run'

const CLASSES = [
  { tamperClass: 1, title: 'Change an amount', detail: 'Move a euro between two entries of one journal. It still balances, so every balance check passes.' },
  { tamperClass: 2, title: 'Change it and cover it up', detail: 'The same, then rewrite the leaf, the chain and the tree so the database agrees with itself.' },
  { tamperClass: 3, title: 'Delete a journal', detail: 'Remove a journal and its entries, with the triggers off.' },
] as const

const LABELS: Record<Verdict['name'], string> = {
  signature: 'The witness signed this root',
  key: 'It is the key the witness publishes',
  rows: "The journal's rows give the logged leaf",
  inclusion: 'The leaf is in the signed tree',
}

function Mark({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="text-warn">?</span>
  return (
    <span className={ok ? 'text-ok' : 'text-bad'}>
      <Drawn ok={ok} label={ok ? 'holds' : 'fails'} />
    </span>
  )
}

export function AuditPanel() {
  const [{ server, seq }, dispatch] = useReducer(reduce, EMPTY)
  const { busy, note, run } = useAction<'restore' | 'tamper' | 'check' | 'verify'>()
  const [verdicts, setVerdicts] = useState<{ seq: number; journalId: string; verdicts: Verdict[] } | null>(null)

  const refresh = useCallback(async () => {
    const response = await fetch('/api/audit/state', { cache: 'no-store' })
    const state = response.ok ? AuditState.safeParse(await response.json()) : undefined
    if (state?.success) dispatch({ type: 'loaded', server: state.data })
  }, [])

  const verifying = isOpen(server?.verification ?? null)

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), verifying ? 2000 : 5000)
    return () => clearInterval(timer)
  }, [refresh, verifying])

  function act(label: 'restore' | 'tamper' | 'verify', url: string, body?: unknown) {
    run(label, async () => {
      try {
        return refusal(await postJson(url, body))
      } finally {
        void refresh()
      }
    })
  }

  function check() {
    setVerdicts(null)
    run('check', async () => {
      const response = await fetch(`/api/audit/seq/${encodeURIComponent(seq)}`, { cache: 'no-store' })
      const answer: unknown = await response.json()
      if (!response.ok || !server?.witnessKey) {
        return errorOf(answer)?.message ?? (server?.witnessKey ? `The web server answered ${response.status}.` : 'The witness key is not available.')
      }
      const evidence = JournalEvidence.safeParse(answer)
      if (!evidence.success) return 'That answer did not have the shape of a journal with its proof.'
      const input = evidence.data
      setVerdicts({ seq: input.proof.seq, journalId: input.proof.journal_id, verdicts: await checkJournal({ ...input, witnessKey: server.witnessKey }) })
      return undefined
    })
  }

  const tamper = server?.tamper
  const caught = verdicts?.verdicts.some((v) => v.ok === false)
  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Tamper with it</h2>
          <p className="text-sm text-muted">Each button changes the database directly as the superuser, the way an insider would. One change at a time.</p>
        </div>
        {tamper ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-bad/40 bg-surface p-4 text-sm">
            <p>
              <span className="font-medium text-bad">
                Journal {tamper.journal_id} at seq {tamper.seq} is tampered with
              </span>{' '}
              (class {tamper.tamper_class}).
              {tamper.restores_at ? ` It goes back on its own at ${new Date(tamper.restores_at).toLocaleTimeString()}.` : ''}
            </p>
            <button
              type="button"
              onClick={() => act('restore', '/api/audit/restore')}
              disabled={busy !== null}
              className="rounded-lg border border-line px-3 py-1.5 font-medium disabled:opacity-50"
            >
              {busy === 'restore' ? 'Restoring…' : 'Restore it'}
            </button>
          </div>
        ) : null}
        {server && !server.tamperAvailable ? <p className="text-sm text-muted">The tamper service can't be reached right now.</p> : null}
        <div className="grid gap-2 sm:grid-cols-3">
          {CLASSES.map((c) => (
            <button
              key={c.tamperClass}
              type="button"
              disabled={busy !== null || !!tamper || !server?.tamperAvailable}
              onClick={() => act('tamper', '/api/audit/tamper', { class: c.tamperClass })}
              className="rounded-xl border border-line bg-surface p-3 text-left transition-colors hover:border-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="block text-sm font-medium">
                {c.tamperClass}. {c.title}
              </span>
              <span className="mt-1 block text-xs text-muted">{c.detail}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Check one journal in your browser</h2>
          <p className="text-sm text-muted">
            Your browser recomputes the leaf from the journal's rows, follows the server's proof to the root, and checks the witness's Ed25519 signature on that
            root itself. The server only supplies data.
          </p>
        </div>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            check()
          }}
        >
          <label className="text-sm text-muted" htmlFor="seq">
            Seq
          </label>
          <input
            id="seq"
            inputMode="numeric"
            value={seq}
            onChange={(e) => dispatch({ type: 'typed', seq: e.target.value.replace(/\D/g, '') })}
            className="w-28 rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-sm"
          />
          <button
            type="submit"
            disabled={busy !== null || seq === ''}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50 dark:text-bg"
          >
            {busy === 'check' ? 'Checking…' : 'Check it'}
          </button>
        </form>
        {verdicts ? (
          <div className="rounded-xl border border-line bg-surface">
            <p className={`border-b border-line px-4 py-3 text-sm font-medium ${caught ? 'text-bad' : 'text-ok'}`}>
              {caught
                ? `Your browser caught it: seq ${verdicts.seq} (journal ${verdicts.journalId}) does not add up.`
                : `Seq ${verdicts.seq} (journal ${verdicts.journalId}) checks out in your browser.`}
            </p>
            <ul className="divide-y divide-line">
              {verdicts.verdicts.map((v) => (
                <li key={v.name} className="grid grid-cols-[1.25rem_1fr] gap-3 px-4 py-2 text-sm">
                  <span className="pt-0.5">
                    <Mark ok={v.ok} />
                  </span>
                  <span>
                    <span className="font-medium">{LABELS[v.name]}</span>
                    <span className="block text-xs text-muted">{v.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Verify the whole log</h2>
          <p className="text-sm text-muted">
            The worker recomputes every leaf from the current rows, rebuilds the tree on its own and compares the root at every size the witness signed. It runs
            in the background, so this page can be closed and opened again while it works.
          </p>
        </div>
        <button
          type="button"
          onClick={() => act('verify', '/api/audit/verify')}
          disabled={busy !== null || verifying}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {busy === 'verify' || verifying ? 'Verifying…' : 'Verify everything'}
        </button>
        {server?.verification ? <VerificationRun run={server.verification} tamperAt={tamper?.at ?? null} /> : null}
      </section>

      {note ? <p className="text-sm text-warn">{note}</p> : null}
    </div>
  )
}
