import { firstRow, type Queryable } from '@carwash/pg'
import type pg from 'pg'

export interface MerchantRow {
  id: string
  code: string
  name: string
  currency: string
  account_id: string
}

const COLUMNS = 'id::text, code, name, currency, account_id::text'

export async function findMerchant(db: Queryable, code: string): Promise<MerchantRow | undefined> {
  const { rows } = await db.query<MerchantRow>(`SELECT ${COLUMNS} FROM merchants WHERE code = $1`, [code])
  return rows[0]
}

export async function insertMerchant(
  client: pg.ClientBase,
  merchant: { code: string; name: string; currency: string; accountId: bigint },
): Promise<MerchantRow> {
  return firstRow(
    await client.query<MerchantRow>(`INSERT INTO merchants (code, name, currency, account_id) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`, [
      merchant.code,
      merchant.name,
      merchant.currency,
      merchant.accountId,
    ]),
  )
}
