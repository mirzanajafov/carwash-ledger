import { randomBytes } from 'node:crypto'
import { createPool, inRollback, withTransaction, type Transaction } from '@carwash/pg'
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
  const pools = trackedPools()
  return {
    name,
    url: (role) => databaseUrl(role, name),
    pool: (role, max = 10) => pools.open(databaseUrl(role, name), max),
    close: () => pools.end(),
    drop: () => dropAfter(pools, name),
  }
}

function trackedPools() {
  const pools: pg.Pool[] = []
  return {
    open(url: string, max: number): pg.Pool {
      const pool = createPool({ connectionString: url, max })
      pools.push(pool)
      return pool
    },
    async end(): Promise<void> {
      await Promise.all(
        pools
          .splice(0)
          .filter((pool) => !pool.ending)
          .map((pool) => pool.end()),
      )
    },
  }
}

async function dropAfter(pools: ReturnType<typeof trackedPools>, name: string): Promise<void> {
  try {
    await pools.end()
  } finally {
    await withAdmin((admin) => admin.query(`DROP DATABASE ${quoteIdent(name)} WITH (FORCE)`))
  }
}

function triggersOff<T>(work: (client: Transaction) => Promise<T>): (client: Transaction) => Promise<T> {
  return async (client) => {
    await client.query('SET LOCAL session_replication_role = replica')
    return work(client)
  }
}

export function withTriggersOff<T>(pool: pg.Pool, work: (client: Transaction) => Promise<T>): Promise<T> {
  return withTransaction(pool, triggersOff(work))
}

export function inRollbackWithTriggersOff<T>(pool: pg.Pool, work: (client: Transaction) => Promise<T>): Promise<T> {
  return inRollback(pool, triggersOff(work))
}

export interface ScratchDatabase {
  readonly name: string
  readonly url: string
  pool(max?: number): pg.Pool
  drop(): Promise<void>
}

export async function createScratchDatabase(prefix: string): Promise<ScratchDatabase> {
  const name = `test_${prefix}_${process.pid}_${randomBytes(4).toString('hex')}`
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${quoteIdent(name)}`))
  const url = databaseUrl('admin', name)
  const pools = trackedPools()
  return {
    name,
    url,
    pool: (max = 10) => pools.open(url, max),
    drop: () => dropAfter(pools, name),
  }
}
