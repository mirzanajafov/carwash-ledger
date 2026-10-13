import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'

export class LocalPostgres {
  readonly #dataDir: string
  readonly #port: number
  readonly #log: string
  #child: ChildProcess | undefined
  #exited: Promise<void> = Promise.resolve()

  constructor(dataDir: string, port: number, log: string) {
    this.#dataDir = dataDir
    this.#port = port
    this.#log = log
  }

  get running(): boolean {
    return this.#child !== undefined
  }

  get adminUrl(): string {
    return `postgresql://carwash@127.0.0.1:${this.#port}/postgres`
  }

  init(): void {
    if (existsSync(join(this.#dataDir, 'PG_VERSION'))) return
    execFileSync('initdb', ['-D', this.#dataDir, '-U', 'carwash', '--auth=trust', '-E', 'UTF8', '--no-instructions'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  }

  start(): void {
    if (this.#child !== undefined) return
    const log = openSync(this.#log, 'a')
    const child = spawn(
      'postgres',
      [
        '-D', this.#dataDir,
        '-c', `port=${this.#port}`,
        '-c', 'listen_addresses=127.0.0.1',
        '-c', 'unix_socket_directories=/tmp',
        '-c', 'max_connections=100',
        '-c', 'shared_buffers=128MB',
        '-c', 'fsync=on',
        '-c', 'synchronous_commit=on',
        '-c', 'recovery_init_sync_method=syncfs',
      ],
      { detached: true, stdio: ['ignore', log, log] },
    )
    this.#child = child
    this.#exited = new Promise((resolve) =>
      child.once('exit', () => {
        if (this.#child === child) this.#child = undefined
        resolve()
      }),
    )
  }

  async waitReady(timeoutMs = 60_000): Promise<number> {
    const started = performance.now()
    for (;;) {
      const client = new pg.Client({ connectionString: this.adminUrl, connectionTimeoutMillis: 1000 })
      client.on('error', () => undefined)
      try {
        await client.connect()
        await client.query('SELECT 1')
        return performance.now() - started
      } catch (error) {
        if (performance.now() - started > timeoutMs) throw error
        await sleep(100)
      } finally {
        await client.end().catch(() => undefined)
      }
    }
  }

  async checkpoint(): Promise<void> {
    const client = new pg.Client({ connectionString: this.adminUrl })
    client.on('error', () => undefined)
    await client.connect()
    try {
      await client.query('CHECKPOINT')
    } finally {
      await client.end()
    }
  }

  async kill(): Promise<void> {
    const child = this.#child
    if (child?.pid === undefined) return
    const pids = [child.pid, ...postgresProcesses().filter((pid) => pid !== child.pid)]
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        continue
      }
    }
    await this.#exited
    while (postgresProcesses().length > 0) await sleep(20)
  }

  async stop(): Promise<void> {
    const child = this.#child
    if (child === undefined) return
    child.kill('SIGINT')
    await this.#exited
  }
}

function postgresProcesses(): number[] {
  const pids: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (readFileSync(`/proc/${entry}/comm`, 'utf8').trim() === 'postgres') pids.push(Number(entry))
    } catch {
      continue
    }
  }
  return pids
}

export async function createRoles(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_owner') THEN
          CREATE ROLE ledger_owner LOGIN CREATEDB;
          CREATE ROLE ledger_app LOGIN;
          CREATE ROLE ledger_audit LOGIN;
        END IF;
      END
      $$`)
  } finally {
    await client.end()
  }
}
