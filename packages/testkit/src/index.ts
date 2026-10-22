import { randomBytes } from 'node:crypto'
import { createPool, inRollback, withTransaction } from '@carwash/pg'
import type pg from 'pg'
import { applyMigration, databaseUrl, migrationNames, quoteIdent, TEMPLATE_DATABASE, withAdmin, type Role } from './template.ts'

export { ADMIN_URL, applyMigration, databaseUrl, migrationNames, migrationSql, prepareTemplate, TEMPLATE_DATABASE, type Role } from './template.ts'
export { signCopies, type SignedCopies } from './witness.ts'

export interface TestDatabase {
  readonly name: string
  url(role: Role): string
  pool(role: Role, max?: number): pg.Pool
  close(): Promise<void>
  drop(): Promise<void>
}

export async function createTestDatabase(options: { template?: string; through?: string } = {}): Promise<TestDatabase> {
  const name = `test_${process.pid}_${randomBytes(4).toString('hex')}`
  const template = options.through === undefined ? quoteIdent(options.template ?? TEMPLATE_DATABASE) : 'template0'
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${template} OWNER ledger_owner`))
  if (options.through !== undefined) {
    const names = migrationNames()
    if (!names.includes(options.through)) throw new Error(`there is no migration ${options.through}`)
    for (const migration of names.slice(0, names.indexOf(options.through) + 1)) await applyMigration(databaseUrl('ledger_owner', name), migration)
  }
  const pools: pg.Pool[] = []
  return {
    name,
    url: (role) => databaseUrl(role, name),
    pool: (role, max = 10) => {
      const pool = createPool({ connectionString: databaseUrl(role, name), max })
      pools.push(pool)
      return pool
    },
    close: async () => {
      await Promise.all(pools.splice(0).map((pool) => pool.end()))
    },
    drop: async () => {
      await Promise.all(pools.splice(0).map((pool) => pool.end()))
      await withAdmin((admin) => admin.query(`DROP DATABASE ${quoteIdent(name)} WITH (FORCE)`))
    },
  }
}

function triggersOff<T>(work: (client: pg.ClientBase) => Promise<T>): (client: pg.ClientBase) => Promise<T> {
  return async (client) => {
    await client.query('SET LOCAL session_replication_role = replica')
    return work(client)
  }
}

export function withTriggersOff<T>(pool: pg.Pool, work: (client: pg.ClientBase) => Promise<T>): Promise<T> {
  return withTransaction(pool, triggersOff(work))
}

export function inRollbackWithTriggersOff<T>(pool: pg.Pool, work: (client: pg.ClientBase) => Promise<T>): Promise<T> {
  return inRollback(pool, triggersOff(work))
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
