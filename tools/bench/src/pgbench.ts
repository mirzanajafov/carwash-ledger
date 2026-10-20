import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface PgbenchOptions {
  url: string
  script: string
  rate: number
  connections: number
  warmupMs: number
  durationMs: number
  defines?: Record<string, string>
}

export interface PgbenchResult {
  latenciesMs: Float64Array
  failures: number
  output: string
}

export async function runPgbench(options: PgbenchOptions): Promise<PgbenchResult> {
  const stamp = `pgb-${process.pid}-${Date.now()}`
  const script = join(tmpdir(), `${stamp}.sql`)
  writeFileSync(script, options.script)
  const url = new URL(options.url)
  const prefix = join(tmpdir(), stamp)
  const args = [
    '-n',
    '-M',
    'extended',
    '-f',
    script,
    '-R',
    String(options.rate),
    '-c',
    String(options.connections),
    '-j',
    String(Math.min(4, options.connections)),
    '-T',
    String(Math.round((options.warmupMs + options.durationMs) / 1000)),
    '--log',
    `--log-prefix=${prefix}`,
    ...Object.entries(options.defines ?? {}).flatMap(([name, value]) => ['-D', `${name}=${value}`]),
    url.pathname.slice(1),
  ]
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  }
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('pgbench', args, { env })
    let text = ''
    child.stdout.on('data', (d) => (text += d))
    child.stderr.on('data', (d) => (text += d))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`pgbench exited ${code}: ${text}`))))
  })

  const rows: { epochUs: number; latencyUs: number }[] = []
  let failures = 0
  for (const file of readdirSync(tmpdir()).filter((f) => f.startsWith(`${stamp}.`) && !f.endsWith('.sql'))) {
    for (const line of readFileSync(join(tmpdir(), file), 'utf8').split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 7) continue
      if (parts[2] === 'skipped' || parts[2] === 'failed') {
        failures++
        continue
      }
      rows.push({
        epochUs: Number(parts[4]) * 1e6 + Number(parts[5]),
        latencyUs: Number(parts[2]) + Number(parts[6]),
      })
    }
    rmSync(join(tmpdir(), file))
  }
  rmSync(script)
  const start = Math.min(...rows.map((r) => r.epochUs - r.latencyUs))
  const latenciesMs = Float64Array.from(rows.filter((r) => r.epochUs - r.latencyUs >= start + options.warmupMs * 1000).map((r) => r.latencyUs / 1000)).sort()
  return { latenciesMs, failures, output }
}
