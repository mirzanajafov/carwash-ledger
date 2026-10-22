import { firstRow, type Queryable, type Transaction } from '@carwash/pg'
import type { Merchant } from './merchant.ts'

interface MerchantRow {
  id: string
  code: string
  name: string
  currency: string
  account_id: string
}

const COLUMNS = 'id::text, code, name, currency, account_id::text'

function toMerchant(row: MerchantRow): Merchant {
  return { id: row.id, code: row.code, name: row.name, currency: row.currency, accountId: BigInt(row.account_id) }
}

export async function findMerchant(db: Queryable, code: string): Promise<Merchant | undefined> {
  const [row] = (await db.query<MerchantRow>(`SELECT ${COLUMNS} FROM merchants WHERE code = $1`, [code])).rows
  return row && toMerchant(row)
}

export async function insertMerchant(client: Transaction, merchant: Omit<Merchant, 'id'>): Promise<Merchant> {
  return toMerchant(
    firstRow(
      await client.query<MerchantRow>(`INSERT INTO merchants (code, name, currency, account_id) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`, [
        merchant.code,
        merchant.name,
        merchant.currency,
        merchant.accountId,
      ]),
    ),
  )
}
