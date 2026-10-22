export interface EntrySpec {
  accountId: string
  amount: string
}

export type Outcome =
  | { kind: 'posted'; journalId: string; attempts: number }
  | { kind: 'duplicate'; journalId: string }
  | { kind: 'retryable'; error: string }
  | { kind: 'rejected'; error: string }

export type ToWorker = { type: 'post'; id: number; ref: string; entries: EntrySpec[]; reversesId?: string | undefined } | { type: 'disarm' }

export type FromWorker = { type: 'outcome'; id: number; outcome: Outcome } | { type: 'snapshot'; accounts: number } | { type: 'snapshot-error'; error: string }

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as { code?: unknown }).code
  return `${error.name}${typeof code === 'string' ? ` ${code}` : ''}: ${error.message}`
}
