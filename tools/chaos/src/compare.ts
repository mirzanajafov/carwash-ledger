import type { Op } from './client.ts'
import type { EntrySpec } from './messages.ts'

export interface LedgerJournal {
  id: string
  externalRef: string
  reversesId: string | null
  entries: EntrySpec[]
}

export interface Finding {
  count: number
  examples: string[]
}

const EXAMPLES = 5

function canonical(entries: readonly EntrySpec[]): string {
  return entries
    .map((e) => `${e.accountId}:${e.amount}`)
    .sort()
    .join(',')
}

export function compareWithClient(ops: Iterable<Op>, journals: readonly LedgerJournal[]): Finding {
  const found: string[] = []
  const byRef = new Map(journals.map((j) => [j.externalRef, j]))
  const sent = new Set<string>()
  for (const op of ops) {
    sent.add(op.ref)
    found.push(...op.conflicts)
    const journal = byRef.get(op.ref)
    if (journal === undefined) {
      if (op.acknowledged) found.push(`${op.ref} was acknowledged as journal ${op.journalId} but is not in the ledger`)
      continue
    }
    if (op.acknowledged && op.journalId !== journal.id) {
      found.push(`${op.ref} was acknowledged as journal ${op.journalId}, the ledger has it as ${journal.id}`)
    }
    if (canonical(journal.entries) !== canonical(op.entries)) {
      found.push(`${op.ref} has entries ${canonical(journal.entries)} in the ledger, the client sent ${canonical(op.entries)}`)
    }
    if ((journal.reversesId ?? undefined) !== op.reversesId) {
      found.push(`${op.ref} reverses ${journal.reversesId ?? 'nothing'} in the ledger, the client asked for ${op.reversesId ?? 'nothing'}`)
    }
  }
  for (const journal of journals) {
    if (!sent.has(journal.externalRef)) found.push(`journal ${journal.id} (${journal.externalRef}) was never sent by a client`)
  }
  return { count: found.length, examples: found.slice(0, EXAMPLES) }
}

export function unsettled(ops: Iterable<Op>): Finding {
  const found: string[] = []
  for (const op of ops) {
    if (op.acknowledged) continue
    found.push(
      op.rejected === undefined
        ? `${op.ref} is still unresolved after ${op.attempts} attempts (${op.lastError ?? 'no answer'})`
        : `${op.ref} was rejected: ${op.rejected}`,
    )
  }
  return { count: found.length, examples: found.slice(0, EXAMPLES) }
}
