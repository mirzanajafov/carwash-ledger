import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

export type Role = 'ledger_owner' | 'ledger_app' | 'ledger_audit' | 'admin'

export const ADMIN_URL = process.env.LEDGER_ADMIN_URL ?? 'postgresql://carwash:carwash@localhost:5449/postgres'
export const TEMPLATE_DATABASE = 'ledger_template'

const DB_PACKAGE = fileURLToPath(new URL('../../db', import.meta.url))
const MIGRATIONS = join(DB_PACKAGE, 'prisma', 'migrations')
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

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

export async function withAdmin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
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

export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

export function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8')
}

export async function applyMigration(url: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  client.on('error', () => undefined)
  await client.connect()
  try {
    await client.query(migrationSql(name))
  } finally {
    await client.end()
  }
}
