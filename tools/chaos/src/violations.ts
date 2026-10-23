import { violations, type InvariantResult } from '@carwash/invariants'

export type Phase = 'during' | 'final'

export interface Violation {
  id: string
  phase: Phase
  description: string
  count: number
  examples: string[]
}

export class Violations {
  readonly list: Violation[] = []

  add(id: string, phase: Phase, description: string, count: number, examples: string[]): void {
    if (count === 0) return
    const existing = this.list.find((v) => v.id === id && v.phase === phase)
    if (existing === undefined) this.list.push({ id, phase, description, count, examples })
    else if (count > existing.count) Object.assign(existing, { count, examples })
  }

  addResults(results: readonly InvariantResult[], phase: Phase): void {
    for (const r of violations(results)) this.add(r.id, phase, r.description, r.count, r.examples)
  }
}

export function byInvariant(runs: readonly { violations: readonly Violation[] }[]): Record<string, { runs: number; count: number }> {
  const found: Record<string, { runs: number; count: number }> = {}
  for (const run of runs) {
    for (const id of new Set(run.violations.map((v) => v.id))) {
      const count = Math.max(...run.violations.filter((v) => v.id === id).map((v) => v.count))
      found[id] = { runs: (found[id]?.runs ?? 0) + 1, count: (found[id]?.count ?? 0) + count }
    }
  }
  return found
}

export function addCounts(into: Record<string, number>, from: Readonly<Record<string, number>>): Record<string, number> {
  for (const [name, n] of Object.entries(from)) into[name] = (into[name] ?? 0) + n
  return into
}
