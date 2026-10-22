import type { Transaction } from '@carwash/pg'

export const EXAMPLES = 5

export interface Check {
  sql: string
  params?: unknown[]
}

export interface Finding {
  count: number
  examples: string[]
}

export async function collect(client: Transaction, checks: readonly Check[]): Promise<Finding> {
  let count = 0
  const examples: string[] = []
  for (const check of checks) {
    const result = await client.query<{ detail: string; total: string }>(
      `SELECT detail, count(*) OVER () AS total FROM (${check.sql}) AS v LIMIT ${EXAMPLES}`,
      check.params,
    )
    const [first] = result.rows
    if (first === undefined) continue
    count += Number(first.total)
    for (const row of result.rows) if (examples.length < EXAMPLES) examples.push(row.detail)
  }
  return { count, examples }
}
