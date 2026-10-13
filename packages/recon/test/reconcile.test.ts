import { describe, expect, it } from 'vitest'
import { contractFee, reconcile, window, type FileLine, type LedgerItem, type ReconcileOptions } from '../src/index.ts'

const contract = { bps: 120n, fixed: 8n }
const options: ReconcileOptions = { contract, fallback: 'unique', settledThrough: 11 }

function item(id: string, kind: 'capture' | 'refund', amount: bigint, day = 10, resolvedAt = 0): LedgerItem {
  return { journalRef: `${kind}:${id}`, attemptId: `att-${id}`, kind, gross: kind === 'capture' ? amount : -amount, day, resolvedAt }
}

function lineFor(it: LedgerItem, extra: Partial<FileLine> = {}): FileLine {
  const fee = contractFee(it.kind, it.gross, contract)
  return { fileId: `stl_EUR_${it.day}`, day: it.day, line: 1, operation: `op-${it.attemptId}`, reference: it.attemptId, kind: it.kind, gross: it.gross, fee, net: it.gross - fee, ...extra }
}

const classes = (result: ReturnType<typeof reconcile>) => result.breaks.map((b) => b.class)

describe('contractFee', () => {
  it('rounds half up and charges refunds nothing', () => {
    expect(contractFee('capture', 1500n, contract)).toBe(26n)
    expect(contractFee('capture', 125n, contract)).toBe(10n)
    expect(contractFee('refund', -1500n, contract)).toBe(0n)
  })
})

describe('reconcile', () => {
  const a = item('a', 'capture', 1500n)
  const b = item('b', 'capture', 2400n)
  const r = item('r', 'refund', 500n)

  it('matches every line by reference and reports nothing when the file is right', () => {
    const result = reconcile([lineFor(a), lineFor(b), lineFor(r)], [a, b, r], options)
    expect(result.breaks).toEqual([])
    expect(result.matches.map((m) => m.how)).toEqual(['reference', 'reference', 'reference'])
  })

  it('reports each kind of fault once, as its own class', () => {
    expect(classes(reconcile([lineFor(a, { gross: 1499n }), lineFor(b)], [a, b], options))).toEqual(['wrong_amount'])
    expect(classes(reconcile([lineFor(a, { fee: 29n }), lineFor(b)], [a, b], options))).toEqual(['fee_difference'])
    expect(classes(reconcile([lineFor(a), lineFor(a), lineFor(b)], [a, b], options))).toEqual(['duplicate_line'])
    expect(classes(reconcile([lineFor(b)], [a, b], options))).toEqual(['missing_line'])
    expect(classes(reconcile([lineFor(a), lineFor(b), lineFor(item('x', 'capture', 900n))], [a, b], options))).toEqual(['unknown_line'])
  })

  it('counts a line that came a day late as a match, and waits a day before calling a line missing', () => {
    const late = reconcile([lineFor(a, { day: 11 }), lineFor(b)], [a, b], options)
    expect(late.breaks).toEqual([])
    expect(late.matches.filter((m) => m.late)).toHaveLength(1)
    const today = item('t', 'capture', 900n, 11)
    expect(reconcile([lineFor(a), lineFor(b)], [a, b, today], options).pending).toEqual([today])
  })

  it('places a line without references only when one candidate fits, or takes the oldest when told to', () => {
    const twin = item('twin', 'capture', 1500n, 10, 5)
    const blind = lineFor(a, { reference: '', operation: 'stl_x' })
    const unique = reconcile([blind, lineFor(b)], [a, b], options)
    expect(unique.breaks).toEqual([])
    expect(unique.matches.find((m) => m.how === 'fallback')!.item).toBe(a)
    expect(classes(reconcile([blind, lineFor(b), lineFor(twin)], [a, b, twin], options))).toEqual([])
    const ambiguous = reconcile([blind, lineFor(b)], [a, b, twin], options)
    expect(classes(ambiguous).sort()).toEqual(['missing_line', 'missing_line', 'unknown_line'])
    const oldest = reconcile([blind, lineFor(b)], [{ ...a, resolvedAt: 9 }, b, twin], { ...options, fallback: 'oldest' })
    expect(oldest.matches.find((m) => m.how === 'fallback')!.item.attemptId).toBe('att-twin')
    expect(classes(oldest)).toEqual(['missing_line'])
  })
})

describe('window', () => {
  it('keeps a week of breaks, and reads the file of the day before it and the payments of the day after', () => {
    expect(window(14, 7)).toEqual({ linesFrom: 6, linesThrough: 14, itemsFrom: 6, itemsThrough: 15, keepFrom: 7, keepThrough: 14 })
  })
})
