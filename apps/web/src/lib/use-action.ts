'use client'

import { errorOf } from '@carwash/contracts'
import { useState } from 'react'

export interface Answer {
  ok: boolean
  status: number
  body: unknown
}

export async function readAnswer(response: Response): Promise<Answer> {
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) }
}

export async function requestJson(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<Answer> {
  const response = await fetch(url, {
    method,
    cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
  return readAnswer(response)
}

export function refusal(answer: Answer): string | undefined {
  return answer.ok ? undefined : (errorOf(answer.body)?.message ?? `The web server answered ${answer.status}.`)
}

export function failureNote(error: unknown): string {
  return error instanceof TypeError ? 'The web server stopped answering.' : 'This page could not read what the web server answered.'
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
        (error: unknown) => {
          console.error(error)
          setNote(failureNote(error))
        },
      )
      .finally(() => setBusy(null))
  }

  return { busy, note, setNote, run }
}
