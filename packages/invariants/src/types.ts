export type InvariantId = 'S1' | 'S2'

export interface InvariantResult {
  id: InvariantId
  description: string
  count: number
  examples: string[]
}

export function violations(results: readonly InvariantResult[]): InvariantResult[] {
  return results.filter((r) => r.count > 0)
}
