import type { BreakClass } from '@carwash/contracts'

export type Kind = 'capture' | 'refund'

export interface FileLine {
  fileId: string
  day: number
  line: number
  operation: string
  reference: string
  kind: Kind
  gross: bigint
  fee: bigint
  net: bigint
}

export interface LedgerItem {
  journalRef: string
  attemptId: string
  kind: Kind
  gross: bigint
  day: number
  resolvedAt: number
}

export interface FeeContract {
  bps: bigint
  fixed: bigint
}

export const FALLBACKS = ['unique', 'oldest', 'none'] as const

export type Fallback = (typeof FALLBACKS)[number]

export interface ReconcileOptions {
  contract: FeeContract
  fallback: Fallback
  settledThrough: number
}

export interface Match {
  line: FileLine
  item: LedgerItem
  how: 'reference' | 'fallback'
  late: boolean
}

export interface Break {
  class: BreakClass
  day: number
  line?: FileLine
  item?: LedgerItem
  detail: string
}

export interface Reconciliation {
  matches: Match[]
  breaks: Break[]
  pending: LedgerItem[]
}

export interface Window {
  linesFrom: number
  linesThrough: number
  itemsFrom: number
  itemsThrough: number
  keepFrom: number
  keepThrough: number
}

export function window(through: number, days: number): Window {
  const keepFrom = through - days
  return { linesFrom: keepFrom - 1, linesThrough: through, itemsFrom: keepFrom - 1, itemsThrough: through + 1, keepFrom, keepThrough: through }
}

export function contractFee(kind: Kind, gross: bigint, contract: FeeContract): bigint {
  if (kind === 'refund') return 0n
  const amount = gross < 0n ? -gross : gross
  return (amount * contract.bps + 5000n) / 10_000n + contract.fixed
}

export function reconcile(lines: readonly FileLine[], items: readonly LedgerItem[], options: ReconcileOptions): Reconciliation {
  const byAttempt = new Map(items.map((item) => [item.attemptId, item]))
  const matched = new Map<LedgerItem, FileLine>()
  const matches: Match[] = []
  const breaks: Break[] = []

  const check = (line: FileLine, item: LedgerItem, how: Match['how']) => {
    matched.set(item, line)
    matches.push({ line, item, how, late: line.day > item.day })
    if (line.gross !== item.gross) {
      breaks.push({ class: 'wrong_amount', day: item.day, line, item, detail: `the file says ${line.gross}, the ledger ${item.gross}` })
    }
    const expected = contractFee(item.kind, item.gross, options.contract)
    if (line.fee !== expected) {
      breaks.push({ class: 'fee_difference', day: item.day, line, item, detail: `the fee is ${line.fee}, the contract says ${expected}` })
    }
  }

  const withReference = lines.filter((line) => line.reference !== '')
  for (const line of withReference) {
    const item = byAttempt.get(line.reference)
    const earlier = item && matched.get(item)
    if (item === undefined) {
      breaks.push({ class: 'unknown_line', day: line.day, line, detail: `no ledger item for reference ${line.reference}` })
    } else if (earlier) {
      breaks.push({
        class: 'duplicate_line',
        day: item.day,
        line,
        item,
        detail: `${item.journalRef} is already settled by ${earlier.fileId} line ${earlier.line}`,
      })
    } else {
      check(line, item, 'reference')
    }
  }

  const byAmount = new Map<string, LedgerItem[]>()
  for (const item of items) {
    const key = `${item.kind}:${item.gross}`
    const list = byAmount.get(key) ?? []
    list.push(item)
    byAmount.set(key, list)
  }
  const candidatesFor = (line: FileLine) =>
    (byAmount.get(`${line.kind}:${line.gross}`) ?? []).filter((item) => !matched.has(item) && Math.abs(item.day - line.day) <= 1)
  for (const line of lines.filter((l) => l.reference === '')) {
    const candidates = options.fallback === 'none' ? [] : candidatesFor(line)
    const pick =
      options.fallback === 'unique' ? (candidates.length === 1 ? candidates[0] : undefined) : candidates.sort((a, b) => a.resolvedAt - b.resolvedAt)[0]
    if (pick === undefined) {
      breaks.push({ class: 'unknown_line', day: line.day, line, detail: `no reference, ${candidates.length} candidates of ${line.gross}` })
    } else {
      check(line, pick, 'fallback')
    }
  }

  const pending: LedgerItem[] = []
  for (const item of items) {
    if (matched.has(item)) continue
    if (item.day < options.settledThrough) breaks.push({ class: 'missing_line', day: item.day, item, detail: `${item.journalRef} is in no file` })
    else pending.push(item)
  }
  return { matches, breaks, pending }
}
