import { checkout } from '@carwash/pg'
import type pg from 'pg'
import { UnknownAccountError } from './errors.ts'
import { INSERT_ACCOUNT, INSERT_BALANCE_ROWS, SELECT_ACCOUNTS, SELECT_ACCOUNTS_BY_CODE } from './sql.ts'
import type { Account, AccountType, BalanceMode, Queryable } from './types.ts'

export type AccountLoader = (ids: readonly bigint[]) => Promise<Account[]>

interface AccountRow {
  id: string
  code: string
  type: string
  currency: string
  balance_mode: string
  shards: number
}

function toAccount(row: AccountRow): Account {
  return {
    id: BigInt(row.id),
    code: row.code,
    type: row.type as AccountType,
    currency: row.currency,
    balanceMode: row.balance_mode as BalanceMode,
    shards: row.shards,
  }
}

export function pgAccountLoader(db: Queryable): AccountLoader {
  return async (ids) => {
    const result = await db.query<AccountRow>(SELECT_ACCOUNTS, [ids.map(String)])
    return result.rows.map(toAccount)
  }
}

export async function findAccounts(db: Queryable, codes: readonly string[]): Promise<Map<string, Account>> {
  const result = await db.query<AccountRow>(SELECT_ACCOUNTS_BY_CODE, [codes])
  return new Map(result.rows.map((row) => [row.code, toAccount(row)]))
}

export class AccountRegistry {
  readonly #accounts = new Map<bigint, Account>()
  readonly #load: AccountLoader

  constructor(load: AccountLoader) {
    this.#load = load
  }

  async resolve(ids: Iterable<bigint>, load: AccountLoader = this.#load): Promise<Map<bigint, Account>> {
    const wanted = [...new Set(ids)]
    const missing = wanted.filter((id) => !this.#accounts.has(id))
    if (missing.length > 0) {
      for (const account of await load(missing)) this.#accounts.set(account.id, account)
    }
    const unknown = wanted.filter((id) => !this.#accounts.has(id))
    if (unknown.length > 0) throw new UnknownAccountError(unknown)
    return new Map(wanted.map((id) => [id, this.#accounts.get(id)!]))
  }
}

export interface NewAccount {
  code: string
  type: AccountType
  currency: string
  balanceMode: BalanceMode
  shards?: number
}

export async function insertAccount(client: pg.ClientBase, spec: NewAccount): Promise<Account> {
  const shards = spec.balanceMode === 'sharded' ? (spec.shards ?? 16) : 1
  const inserted = await client.query<{ id: string }>(INSERT_ACCOUNT, [spec.code, spec.type, spec.currency, spec.balanceMode, shards])
  const id = BigInt(inserted.rows[0]!.id)
  if (spec.balanceMode !== 'derived') await client.query(INSERT_BALANCE_ROWS, [id.toString(), shards])
  return { id, code: spec.code, type: spec.type, currency: spec.currency, balanceMode: spec.balanceMode, shards }
}

export async function createAccount(pool: pg.Pool, spec: NewAccount): Promise<Account> {
  const lease = await checkout(pool)
  const { client } = lease
  try {
    await client.query('BEGIN')
    const account = await insertAccount(client, spec)
    await client.query('COMMIT')
    return account
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    lease.release()
  }
}
