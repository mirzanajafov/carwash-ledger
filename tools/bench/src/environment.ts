import { execFileSync } from 'node:child_process'
import { cpus, totalmem } from 'node:os'
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
  return `cpu.max=${max} cpuset=${String(read('cpuset.cpus.effective'))} memory.max=${String(read('memory.max'))}`
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
