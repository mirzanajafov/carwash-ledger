import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { kafkaClient } from '@carwash/outbox'
import { firstRow } from '@carwash/pg'
import pg from 'pg'

export async function activity(adminUrl: string, database: string): Promise<string> {
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 2000 })
  client.on('error', () => undefined)
  try {
    await client.connect()
    const { rows } = await client.query<{ state: string; wait: string; n: number; oldest: number }>(
      `SELECT coalesce(state, '-') AS state, coalesce(wait_event_type || ':' || wait_event, '-') AS wait, count(*)::int AS n,
              coalesce(max(extract(epoch FROM now() - xact_start)), 0)::int AS oldest
       FROM pg_stat_activity WHERE datname = $1 GROUP BY 1, 2 ORDER BY 3 DESC`,
      [database],
    )
    const stuck = await client.query<{ pid: number; state: string; age: number; blockers: number[]; query: string }>(
      `SELECT pid, state, extract(epoch FROM now() - xact_start)::int AS age, pg_blocking_pids(pid) AS blockers, left(query, 160) AS query
       FROM pg_stat_activity
       WHERE datname = $1 AND xact_start < now() - interval '3 seconds'
       ORDER BY xact_start LIMIT 4`,
      [database],
    )
    const summary = rows.map((r) => `${r.state} ${r.wait} ${r.n} (oldest ${r.oldest} s)`).join(', ')
    const detail = stuck.rows.map((r) => `[${r.pid} ${r.state} ${r.age} s blocked by ${JSON.stringify(r.blockers)}: ${r.query.replace(/\s+/g, ' ')}]`)
    return [summary, ...detail].join(' ')
  } catch {
    return 'activity unavailable'
  } finally {
    await client.end().catch(() => undefined)
  }
}

export async function keepLogs(from: string, to: string, seed: number): Promise<void> {
  mkdirSync(to, { recursive: true })
  for (const name of ['psp', 'witness', 'api-0', 'api-1', 'worker', 'kafka']) {
    await pipeline(createReadStream(join(from, `${name}.log`)), createGzip(), createWriteStream(join(to, `seed-${seed}-${name}.log.gz`)))
  }
  rmSync(from, { recursive: true, force: true })
}

export async function pendingAttempts(audit: pg.Pool): Promise<string> {
  try {
    const { n } = firstRow(await audit.query<{ n: number }>(`SELECT count(*)::int AS n FROM attempts WHERE status = 'pending'`))
    return String(n)
  } catch {
    return 'unknown'
  }
}

export async function publishedMessages(broker: string): Promise<Record<string, number>> {
  const admin = kafkaClient({ brokers: [broker], clientId: 'chaos-harness' }).admin()
  try {
    await admin.connect()
    const counts: Record<string, number> = {}
    for (const topic of ['payments', 'ledger']) {
      const offsets = await admin.fetchTopicOffsets(topic)
      counts[`kafka ${topic}`] = offsets.reduce((sum, p) => sum + Number(p.high) - Number(p.low), 0)
    }
    return counts
  } catch {
    return {}
  } finally {
    await admin.disconnect().catch(() => undefined)
  }
}

export async function countBy(pool: pg.Pool, sql: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ name: string; n: number }>(sql)
  return Object.fromEntries(rows.map((row) => [row.name, row.n]))
}
