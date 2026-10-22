'use client'

import { useRouter } from 'next/navigation'
import { useState, type SubmitEvent } from 'react'

export function AdminLogin() {
  const router = useRouter()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setNote(null)
    try {
      const response = await fetch('/api/admin/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })
      const body = await response.json().catch(() => null)
      if (response.ok) {
        setKey('')
        router.refresh()
      } else {
        setNote(body?.error?.message ?? `The web server answered ${response.status}.`)
      }
    } catch {
      setNote('The web server stopped answering.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="max-w-md space-y-3">
      <label className="block space-y-1">
        <span className="block text-sm font-medium">Admin API key</span>
        <input
          type="password"
          name="key"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm"
          placeholder="cw_admin_…"
        />
      </label>
      <button
        type="submit"
        disabled={busy || key.length === 0}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:text-bg"
      >
        {busy ? 'Checking…' : 'Log in'}
      </button>
      {note ? <p className="text-sm text-warn">{note}</p> : null}
    </form>
  )
}

export function AdminLogout() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function logout() {
    setBusy(true)
    try {
      await fetch('/api/admin/session', { method: 'DELETE' })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={logout}
      disabled={busy}
      className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium disabled:opacity-50"
    >
      {busy ? 'Logging out…' : 'Log out'}
    </button>
  )
}
