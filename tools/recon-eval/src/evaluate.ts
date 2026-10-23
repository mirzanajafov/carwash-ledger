import type { BreakClass } from '@carwash/contracts'
import { reconcile, window, type Break, type Fallback, type FeeContract, type FileLine } from '@carwash/recon'
import { FAULTS, type Fault, type LabelledItem, type World } from './generate.ts'

export interface EvalOptions {
  fallback: Fallback
  windowDays: number
  contract: FeeContract
}

export interface FaultScore {
  injected: number
  detected: number
  wrongClass: number
  missed: number
}

export interface Evaluation {
  items: number
  lines: number
  breaks: number
  faults: Record<Fault, FaultScore>
  dropped: { placedRight: number; placedWrong: number; unplaced: number }
  falseBreaks: number
  falseExamples: string[]
  transientBreaks: number
  transientByClass: Partial<Record<BreakClass, number>>
}

const EXPECTED: Record<Exclude<Fault, 'droppedReference' | 'nextDay'>, BreakClass> = {
  missingLine: 'missing_line',
  duplicateLine: 'duplicate_line',
  wrongAmount: 'wrong_amount',
  feeDifference: 'fee_difference',
}

export function simulate(
  world: World,
  options: EvalOptions,
): { breaks: Break[]; placement: Map<FileLine, LabelledItem>; transientBreaks: number; transientByClass: Partial<Record<BreakClass, number>> } {
  const lastDay = Math.max(...world.items.map((item) => item.day)) + 1
  const byDay = new Map<number, Break[]>()
  const placement = new Map<FileLine, LabelledItem>()
  const seen = new Set<string>()
  const key = (b: Break) => `${b.class}:${b.item?.attemptId ?? ''}:${b.line ? `${b.line.fileId}/${b.line.line}` : ''}`
  for (let day = 0; day <= lastDay; day++) {
    const span = window(day, options.windowDays)
    const lines: FileLine[] = []
    for (let d = span.linesFrom; d <= span.linesThrough; d++) lines.push(...(world.files.get(d) ?? []))
    const items = world.items.filter((item) => item.day >= span.itemsFrom && item.day <= span.itemsThrough)
    const result = reconcile(lines, items, { contract: options.contract, fallback: options.fallback, settledThrough: day })
    for (let d = Math.max(0, span.keepFrom); d <= span.keepThrough; d++)
      byDay.set(
        d,
        result.breaks.filter((b) => b.day === d),
      )
    for (const match of result.matches) placement.set(match.line, match.item as LabelledItem)
    for (const b of result.breaks) if (b.day >= span.keepFrom && b.day <= span.keepThrough) seen.add(key(b))
  }
  const breaks = [...byDay.values()].flat()
  const final = new Set(breaks.map(key))
  const transient = [...seen].filter((k) => !final.has(k))
  const transientByClass: Partial<Record<BreakClass, number>> = {}
  for (const k of transient) {
    const cls = k.split(':')[0] as BreakClass
    transientByClass[cls] = (transientByClass[cls] ?? 0) + 1
  }
  return { breaks, placement, transientBreaks: transient.length, transientByClass }
}

export function evaluate(world: World, options: EvalOptions): Evaluation {
  const { breaks, placement, transientBreaks, transientByClass } = simulate(world, options)
  const on = new Map<LabelledItem, BreakClass[]>()
  const falseExamples: string[] = []
  let falseBreaks = 0
  for (const b of breaks) {
    const subject = (b.item as LabelledItem | undefined) ?? (b.line ? world.owner.get(b.line) : undefined)
    if (!subject?.fault) {
      falseBreaks++
      if (falseExamples.length < 5) falseExamples.push(`${b.class}: ${b.detail}`)
      continue
    }
    on.set(subject, [...(on.get(subject) ?? []), b.class])
  }
  const faults = Object.fromEntries(FAULTS.map((f) => [f, { injected: 0, detected: 0, wrongClass: 0, missed: 0 }])) as Record<Fault, FaultScore>
  const dropped = { placedRight: 0, placedWrong: 0, unplaced: 0 }
  const placedFor = new Map<LabelledItem, LabelledItem[]>()
  for (const [line, item] of placement) {
    const truth = world.owner.get(line)
    if (truth === undefined) throw new Error(`line ${line.line} of ${line.fileId} has no item in the world`)
    placedFor.set(truth, [...(placedFor.get(truth) ?? []), item])
  }
  for (const item of world.items) {
    if (item.fault === null) continue
    const score = faults[item.fault]
    score.injected++
    const found = on.get(item) ?? []
    if (item.fault === 'nextDay') {
      if (found.length === 0) score.detected++
      else score.wrongClass++
      continue
    }
    if (item.fault === 'droppedReference') {
      const placed = placedFor.get(item) ?? []
      if (placed.includes(item)) dropped.placedRight++
      else if (placed.length > 0) dropped.placedWrong++
      else dropped.unplaced++
      if (placed.includes(item) || (placed.length === 0 && found.length > 0)) score.detected++
      else if (placed.length > 0) score.wrongClass++
      else score.missed++
      continue
    }
    if (found.includes(EXPECTED[item.fault])) score.detected++
    else if (found.length > 0) score.wrongClass++
    else score.missed++
  }
  return {
    items: world.items.length,
    lines: [...world.files.values()].reduce((n, lines) => n + lines.length, 0),
    breaks: breaks.length,
    faults,
    dropped,
    falseBreaks,
    falseExamples,
    transientBreaks,
    transientByClass,
  }
}
