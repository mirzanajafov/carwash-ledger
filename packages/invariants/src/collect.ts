import { checkout } from '@carwash/pg'
import type pg from 'pg'

export const EXAMPLES = 5

export interface Check {
  sql: string
}

export interface Finding {
  count: number
  examples: string[]
}

export async function collect(client: pg.ClientBase, checks: readonly Check[]): Promise<Finding> {
  let count = 0
  const examples: string[] = []
  for (const check of checks) {
    const result = await client.query<{ detail: string; total: string }>(`SELECT detail, count(*) OVER () AS total FROM (${check.sql}) AS v LIMIT ${EXAMPLES}`)
    if (result.rows.length === 0) continue
    count += Number(result.rows[0]!.total)
    for (const row of result.rows) if (examples.length < EXAMPLES) examples.push(row.detail)
  }
  return { count, examples }
}

export async function inSnapshot<T>(pool: pg.Pool, read: (client: pg.ClientBase) => Promise<T>): Promise<T> {
  const lease = await checkout(pool)
  const { client } = lease
  let broken = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const value = await read(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      broken = true
    })
    throw error
  } finally {
    lease.release(broken)
  }
}
