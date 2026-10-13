export type InvariantId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'L1'

export interface InvariantResult {
  id: InvariantId
  description: string
  count: number
  examples: string[]
}

export function violations(results: readonly InvariantResult[]): InvariantResult[] {
  return results.filter((r) => r.count > 0)
}
