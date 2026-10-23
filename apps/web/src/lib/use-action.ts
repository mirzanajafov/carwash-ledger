'use client'

import { errorOf } from '@carwash/contracts'
import { useState } from 'react'

export interface Answer {
  ok: boolean
  status: number
  body: unknown
}

export async function postJson(url: string, body?: unknown): Promise<Answer> {
  const response = await fetch(url, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) }
}

export function refusal(answer: Answer): string | undefined {
  return answer.ok ? undefined : (errorOf(answer.body)?.message ?? `The web server answered ${answer.status}.`)
}

export function useAction<Label extends string>() {
  const [busy, setBusy] = useState<Label | null>(null)
  const [note, setNote] = useState<string | null>(null)

  function run(label: Label, task: () => Promise<string | undefined>): void {
    setBusy(label)
    setNote(null)
    void task()
      .then(
        (message) => setNote(message ?? null),
        () => setNote('The web server stopped answering.'),
      )
      .finally(() => setBusy(null))
  }

  return { busy, note, setNote, run }
}
