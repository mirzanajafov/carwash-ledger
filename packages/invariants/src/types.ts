export type InvariantId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5'

export interface InvariantResult {
  id: InvariantId
  description: string
  count: number
  examples: string[]
}

export function violations(results: readonly InvariantResult[]): InvariantResult[] {
  return results.filter((r) => r.count > 0)
}
