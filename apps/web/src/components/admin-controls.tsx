'use client'

import { useRouter } from 'next/navigation'
import { useState, type SubmitEvent } from 'react'
import { postJson, refusal, useAction } from '@/lib/use-action'

export function AdminLogin() {
  const router = useRouter()
  const [key, setKey] = useState('')
  const { busy, note, run } = useAction<'login'>()

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    run('login', async () => {
      const answer = await postJson('/api/admin/session', { key })
      if (answer.ok) {
        setKey('')
        router.refresh()
      }
      return refusal(answer)
    })
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
        disabled={busy !== null || key.length === 0}
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
  const { busy, run } = useAction<'logout'>()

  function logout() {
    run('logout', async () => {
      await fetch('/api/admin/session', { method: 'DELETE' })
      router.refresh()
      return undefined
    })
  }

  return (
    <button
      type="button"
      onClick={logout}
      disabled={busy !== null}
      className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium disabled:opacity-50"
    >
      {busy ? 'Logging out…' : 'Log out'}
    </button>
  )
}
