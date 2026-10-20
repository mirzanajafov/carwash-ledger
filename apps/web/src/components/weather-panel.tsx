'use client'

import { useCallback, useEffect, useState } from 'react'
import { describePlan, PRESETS, secondsLeft, type Preset, type Weather } from '@/lib/weather'

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function WeatherPanel({ admin = false }: { admin?: boolean }) {
  const [state, setState] = useState<Weather | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<Preset['name'] | 'custom' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [minutes, setMinutes] = useState('10')

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/weather', { cache: 'no-store' })
      if (response.ok) setState((await response.json()) as Weather)
    } catch {
      return
    }
  }, [])

  useEffect(() => {
    void load()
    const poll = setInterval(load, 5000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [load])

  async function send(name: Preset['name'] | 'custom', payload: unknown) {
    setBusy(name)
    setNote(null)
    try {
      const response = await fetch('/api/weather', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      const body = await response.json().catch(() => null)
      if (response.ok) setState(body as Weather)
      else setNote(body?.error?.message ?? `The web server answered ${response.status}.`)
    } catch {
      setNote('The web server stopped answering.')
    } finally {
      setBusy(null)
    }
  }

  function choose(preset: Preset) {
    return send(preset.name, { preset: preset.name })
  }

  function apply() {
    let plan: unknown
    try {
      plan = JSON.parse(draft ?? '{}')
    } catch {
      setNote('The plan is not valid JSON.')
      return
    }
    return send('custom', { custom: { plan, minutes: Number(minutes) } })
  }

  const weather = state?.weather && secondsLeft(state.weather.until, now) > 0 ? state.weather : null
  const current = weather ? PRESETS.find((p) => p.name === weather.label) : PRESETS[0]
  const title = current?.title ?? (weather?.label === 'custom' ? 'Set by hand' : weather?.label)
  const plan = weather?.plan ?? state?.base ?? null
  const faults = plan ? describePlan(plan) : []

  return (
    <section className="space-y-4" aria-labelledby="weather-title">
      <div className="max-w-2xl space-y-2">
        <h2 id="weather-title" className="text-xl font-semibold tracking-tight">
          The bank&apos;s weather.
        </h2>
        <p className="text-muted">
          The bank is simulated, so it can be told to misbehave. Make it flaky or start a storm, then watch the live page: payments still settle once, the
          recovery job asks the bank what really happened, and the next settlement day shows the breaks reconciliation found.
        </p>
      </div>

      <div className="rounded-xl border border-line bg-surface p-4 text-sm">
        {state ? (
          <>
            <p>
              <span className="font-medium">{title}</span>
              {weather ? <span className="text-muted tabular-nums"> · {clock(secondsLeft(weather.until, now))} left</span> : null}
            </p>
            <p className="mt-1 text-xs text-muted">{faults.length > 0 ? faults.join(' · ') : 'No faults at all.'}</p>
          </>
        ) : (
          <p className="text-muted">Asking the bank…</p>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {PRESETS.map((preset) => {
          const active = current?.name === preset.name
          return (
            <button
              key={preset.name}
              type="button"
              onClick={() => choose(preset)}
              disabled={busy !== null || !state}
              aria-pressed={active}
              className={`rounded-xl border p-3 text-left transition-colors disabled:opacity-60 ${active ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-muted'}`}
            >
              <span className="block text-sm font-medium">{busy === preset.name ? 'Changing…' : preset.title}</span>
              <span className="block text-xs text-muted">{preset.detail}</span>
            </button>
          )
        })}
      </div>

      <p className="text-xs text-muted">
        {admin
          ? 'Admin session: presets start without waiting for a turn, and the plan below can be anything for up to an hour.'
          : 'A flaky bank or a storm lasts 5 minutes and can be started once a minute for everyone. An ordinary day can be brought back any time.'}
      </p>
      {admin ? (
        <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
          <label className="block space-y-1">
            <span className="block text-sm font-medium">Fault plan</span>
            <textarea
              value={draft ?? JSON.stringify(plan ?? {}, null, 2)}
              onChange={(event) => setDraft(event.target.value)}
              rows={10}
              spellCheck={false}
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-xs"
            />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1">
              <span className="block text-sm font-medium">Minutes</span>
              <input
                type="number"
                min={1}
                max={60}
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                className="w-24 rounded-lg border border-line bg-bg px-3 py-2 text-sm tabular-nums"
              />
            </label>
            <button
              type="button"
              onClick={apply}
              disabled={busy !== null}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:text-bg"
            >
              {busy === 'custom' ? 'Setting…' : 'Set this weather'}
            </button>
          </div>
        </div>
      ) : null}
      {note ? <p className="text-sm text-warn">{note}</p> : null}
    </section>
  )
}
