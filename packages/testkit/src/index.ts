import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createPool } from '@carwash/pg'
import pg from 'pg'

export type Role = 'ledger_owner' | 'ledger_app' | 'ledger_audit' | 'admin'

export const ADMIN_URL = process.env.LEDGER_ADMIN_URL ?? 'postgresql://carwash:carwash@localhost:5449/postgres'
export const TEMPLATE_DATABASE = 'ledger_template'

const DB_PACKAGE = fileURLToPath(new URL('../../db', import.meta.url))
const PRISMA_CLI = fileURLToPath(new URL('../../db/node_modules/prisma/build/index.js', import.meta.url))

const PASSWORDS: Record<Exclude<Role, 'admin'>, string> = {
  ledger_owner: process.env.LEDGER_OWNER_PASSWORD ?? 'ledger_owner',
  ledger_app: process.env.LEDGER_APP_PASSWORD ?? 'ledger_app',
  ledger_audit: process.env.LEDGER_AUDIT_PASSWORD ?? 'ledger_audit',
}

export function databaseUrl(role: Role, database: string): string {
  const url = new URL(ADMIN_URL)
  if (role !== 'admin') {
    url.username = role
    url.password = PASSWORDS[role]
  }
  url.pathname = `/${database}`
  return url.toString()
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

async function withAdmin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_URL })
  client.on('error', () => undefined)
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

export async function prepareTemplate(): Promise<void> {
  await withAdmin(async (admin) => {
    const stale = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE 'test\\_%'`,
      [TEMPLATE_DATABASE],
    )
    for (const { datname } of stale.rows) {
      await admin.query(`ALTER DATABASE ${quoteIdent(datname)} WITH IS_TEMPLATE false`)
      await admin.query(`DROP DATABASE ${quoteIdent(datname)} WITH (FORCE)`)
    }
    await admin.query(`CREATE DATABASE ${quoteIdent(TEMPLATE_DATABASE)} OWNER ledger_owner`)
  })
  execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
    cwd: DB_PACKAGE,
    env: { ...process.env, DATABASE_URL: databaseUrl('ledger_owner', TEMPLATE_DATABASE) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  await withAdmin((admin) => admin.query(`ALTER DATABASE ${quoteIdent(TEMPLATE_DATABASE)} WITH IS_TEMPLATE true`))
}

export interface TestDatabase {
  readonly name: string
  url(role: Role): string
  pool(role: Role, max?: number): pg.Pool
  drop(): Promise<void>
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `test_${process.pid}_${randomBytes(4).toString('hex')}`
  await withAdmin((admin) =>
    admin.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(TEMPLATE_DATABASE)} OWNER ledger_owner`),
  )
  const pools: pg.Pool[] = []
  return {
    name,
    url: (role) => databaseUrl(role, name),
    pool: (role, max = 10) => {
      const pool = createPool({ connectionString: databaseUrl(role, name), max })
      pools.push(pool)
      return pool
    },
    drop: async () => {
      await Promise.all(pools.map((pool) => pool.end()))
      await withAdmin((admin) => admin.query(`DROP DATABASE ${quoteIdent(name)} WITH (FORCE)`))
    },
  }
}

export interface ScratchDatabase {
  readonly name: string
  readonly url: string
  drop(): Promise<void>
}

export async function createScratchDatabase(prefix: string): Promise<ScratchDatabase> {
  const name = `test_${prefix}_${process.pid}_${randomBytes(4).toString('hex')}`
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${quoteIdent(name)}`))
  return {
    name,
    url: databaseUrl('admin', name),
    drop: async () => {
      await withAdmin((admin) => admin.query(`DROP DATABASE ${quoteIdent(name)} WITH (FORCE)`))
    },
  }
}
