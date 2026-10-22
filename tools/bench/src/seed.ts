import type { Account, BalanceMode } from '@carwash/ledger'
import type pg from 'pg'

export interface CaptureAccounts {
  hot: [Account, Account]
  merchants: bigint[]
}

export async function seedCaptureAccounts(
  app: pg.Pool,
  mode: BalanceMode,
  shards: number,
  merchantCount: number,
  merchantMode: BalanceMode = 'locked',
): Promise<CaptureAccounts> {
  const hot = await app.query<{ id: string; code: string }>(
    `INSERT INTO accounts (code, type, currency, balance_mode, shards)
     VALUES ('psp_receivable', 'asset', 'EUR', $1::balance_mode, $2), ('platform_fees', 'revenue', 'EUR', $1::balance_mode, $2)
     RETURNING id::text, code`,
    [mode, shards],
  )
  const merchants = await app.query<{ id: string }>(
    `INSERT INTO accounts (code, type, currency, balance_mode)
     SELECT 'merchant_' || n, 'liability', 'EUR', $2::balance_mode FROM generate_series(1, $1::int) AS n
     RETURNING id::text`,
    [merchantCount, merchantMode],
  )
  await app.query(
    `INSERT INTO balances (account_id, shard)
     SELECT a.id, s FROM accounts a, generate_series(0, a.shards - 1) AS s
     WHERE a.balance_mode <> 'derived'`,
  )
  const byCode = new Map(hot.rows.map((r) => [r.code, BigInt(r.id)]))
  const account = (code: string, type: Account['type']): Account => {
    const id = byCode.get(code)
    if (id === undefined) throw new Error(`account ${code} was not created`)
    return { id, code, type, currency: 'EUR', balanceMode: mode, shards }
  }
  return {
    hot: [account('psp_receivable', 'asset'), account('platform_fees', 'revenue')],
    merchants: merchants.rows.map((r) => BigInt(r.id)),
  }
}
