'use client'

import { useState } from 'react'
import { merchantName } from '@/lib/accounts'
import { money } from '@/lib/money'
import { CRASH_POINTS, type Check, type CrashPoint, type Step } from '@/lib/plug'
import { ChecksTable } from './checks-table'

function seconds(ms: number): string {
  return `+${(ms / 1000).toFixed(2)} s`
}

type Line = { step: Step; tries: number; until: number }

function group(steps: readonly Step[]): Line[] {
  const lines: Line[] = []
  for (const step of steps) {
    const last = lines.at(-1)
    if (step.kind === 'retry' && last?.step.kind === 'retry' && last.step.status === step.status && last.step.code === step.code) {
      last.tries++
      last.until = step.at
      continue
    }
    lines.push({ step, tries: 1, until: step.at })
  }
  return lines
}

function describe(step: Step, tries = 1, until = step.at): { text: string; tone: string } {
  switch (step.kind) {
    case 'armed':
      return { text: `Armed ${step.failpoint} in API process ${step.pid}.`, tone: 'text-ink' }
    case 'refused':
      return {
        text: step.status === 429 ? `Somebody pulled the plug less than a minute ago; ${step.message.replace(/^this/, 'it')}.` : step.message,
        tone: 'text-warn',
      }
    case 'sent':
      return { text: `Sent a ${money(step.amount)} wash at ${merchantName(step.merchant)} with idempotency key ${step.key.slice(0, 8)}…`, tone: 'text-ink' }
    case 'lost':
      return { text: `The connection dropped (${step.error}). The process died at the crash point.`, tone: 'text-bad' }
    case 'back':
      return { text: `A new API process, ${step.pid}, answers ${(step.downMs / 1000).toFixed(1)} s later.`, tone: 'text-ok' }
    case 'retry': {
      const which = tries > 1 ? `Tries ${step.attempt} to ${step.attempt + tries - 1}` : `Try ${step.attempt}`
      const over = tries > 1 ? ` for ${((until - step.at) / 1000 + step.waitMs / 1000).toFixed(0)} s` : ''
      return {
        text:
          step.code === 'request_in_progress'
            ? `${which} with the same key: 409${over}. The dead request still holds the key's lease until it expires, so nobody can run it twice.`
            : `${which} with the same key: ${step.status}${step.code ? ` ${step.code}` : ''}${over}.`,
        tone: 'text-muted',
      }
    }
    case 'answered':
      return { text: `Try ${step.attempt} with the same key answers ${step.status}: one payment, ${step.paymentStatus ?? 'no payment'}.`, tone: 'text-ok' }
    case 'checks':
      return { text: 'The invariants, checked as the read-only audit role:', tone: 'text-ink' }
    case 'failed':
      return { text: step.message, tone: 'text-bad' }
  }
}

export function PlugPanel() {
  const [point, setPoint] = useState<CrashPoint>('attempt.after_psp')
  const [steps, setSteps] = useState<Step[]>([])
  const [running, setRunning] = useState(false)
  const [checks, setChecks] = useState<{ ms: number; results: Check[] } | null>(null)
  const [checking, setChecking] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function pull() {
    setRunning(true)
    setSteps([])
    setNote(null)
    try {
      const response = await fetch('/api/plug', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ failpoint: point }) })
      if (!response.ok || !response.body) {
        setNote(`The web server answered ${response.status}.`)
        return
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += value
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) setSteps((previous) => [...previous, JSON.parse(line) as Step])
      }
    } catch {
      setNote('The web server stopped answering.')
    } finally {
      setRunning(false)
    }
  }

  async function check() {
    setChecking(true)
    setNote(null)
    try {
      const response = await fetch('/api/checks', { method: 'POST' })
      const body = await response.json()
      if (response.ok) setChecks({ ms: body.ms, results: body.results })
      else setNote(body?.error?.message ?? `The checks answered ${response.status}.`)
    } finally {
      setChecking(false)
    }
  }

  const finalChecks = steps.find((s): s is Extract<Step, { kind: 'checks' }> => s.kind === 'checks')
  return (
    <div className="space-y-8">
      <fieldset className="space-y-3">
        <legend className="mb-2 text-base font-semibold">Where should it die?</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {CRASH_POINTS.map((crash) => (
            <label
              key={crash.failpoint}
              className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors ${point === crash.failpoint ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-muted'}`}
            >
              <input type="radio" name="crash" className="mt-1 accent-[var(--accent)]" checked={point === crash.failpoint} onChange={() => setPoint(crash.failpoint)} disabled={running} />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{crash.title}</span>
                <span className="block text-xs text-muted">{crash.detail}</span>
                <span className="mt-1 block truncate font-mono text-[11px] text-muted">{crash.failpoint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={pull} disabled={running} className="rounded-lg bg-bad px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:text-bg">
          {running ? 'Pulling…' : 'Pull the plug'}
        </button>
        <button type="button" onClick={check} disabled={checking || running} className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium disabled:opacity-50">
          {checking ? 'Checking…' : 'Just run the checks'}
        </button>
        <span className="text-xs text-muted">One plug a minute for everyone; the checks at most every 10 s.</span>
      </div>

      {note ? <p className="text-sm text-warn">{note}</p> : null}

      {steps.length > 0 ? (
        <ol className="space-y-2 rounded-xl border border-line bg-surface p-4">
          {group(steps).map(({ step, tries, until }, i) => {
            const { text, tone } = describe(step, tries, until)
            return (
              <li key={i} className="arrive grid grid-cols-[4.5rem_1fr] gap-3 text-sm">
                <span className="font-mono text-xs leading-5 text-muted tabular-nums">{seconds(step.at)}</span>
                <span className={tone}>{text}</span>
              </li>
            )
          })}
          {running ? <li className="pl-[5.25rem] text-xs text-muted">…</li> : null}
        </ol>
      ) : null}

      {finalChecks ? <ChecksTable results={finalChecks.results} ms={finalChecks.ms} /> : checks ? <ChecksTable results={checks.results} ms={checks.ms} /> : null}
    </div>
  )
}
