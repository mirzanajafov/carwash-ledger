import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'

function tryRun(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

function postgresCgroup(): string {
  if (process.env.PG_CGROUP && process.env.PG_CGROUP !== 'unknown') return process.env.PG_CGROUP
  const read = (file: string) => tryRun('docker', ['exec', 'carwash-postgres', 'cat', `/sys/fs/cgroup/${file}`])
  const max = read('cpu.max')
  if (max === undefined) return 'unknown'
  return `cpu.max=${max} cpuset=${read('cpuset.cpus.effective')} memory.max=${read('memory.max')}`
}

export async function describeEnvironment(admin: pg.Pool): Promise<Record<string, unknown>> {
  const settings = await admin.query<{ name: string; setting: string }>(
    `SELECT name, setting FROM pg_settings
     WHERE name IN ('server_version', 'shared_buffers', 'synchronous_commit', 'fsync', 'wal_sync_method', 'max_connections')`,
  )
  return {
    commit:
      process.env.GIT_COMMIT && process.env.GIT_COMMIT !== 'unknown' ? process.env.GIT_COMMIT : (tryRun('git', ['rev-parse', '--short', 'HEAD']) ?? 'unknown'),
    node: process.version,
    platform: process.platform,
    cpu: cpus()[0]?.model,
    cpus: cpus().length,
    memoryGb: Math.round(totalmem() / 1e9),
    postgresCgroup: postgresCgroup(),
    postgres: Object.fromEntries(settings.rows.map((r) => [r.name, r.setting])),
  }
}

function toJson(data: unknown, indent?: number): string {
  return JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), indent)
}

export function createResultsDir(dir: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
  const target = join(dir, stamp)
  mkdirSync(target, { recursive: true })
  return target
}

export function appendJsonLine(file: string, data: unknown): void {
  appendFileSync(file, toJson(data) + '\n')
}

export function writeJson(file: string, data: unknown): string {
  writeFileSync(file, toJson(data, 2) + '\n')
  return file
}

export function writeResults(dir: string, data: unknown): string {
  return writeJson(join(createResultsDir(dir), 'results.json'), data)
}

export function percentile(sorted: ArrayLike<number>, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN
}

export function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}
