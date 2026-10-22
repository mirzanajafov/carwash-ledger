import { firstRow, withTransaction } from '@carwash/pg'
import type pg from 'pg'

export const MERCHANTS = 50
const BATCH = 50_000
const PRICES = [900, 1500, 2400, 3500, 4900]

export interface SeedAccounts {
  receivable: string
  fees: string
  pspFees: string
  merchants: string[]
}

export async function createSeedAccounts(app: pg.Pool, merchants = MERCHANTS): Promise<SeedAccounts> {
  const create = async (code: string, type: string) => {
    const { id } = firstRow(
      await app.query<{ id: string }>(
        `INSERT INTO accounts (code, type, currency, balance_mode, shards) VALUES ($1, $2::account_type, 'EUR', 'derived', 1) RETURNING id::text`,
        [code, type],
      ),
    )
    return id
  }
  const accounts: SeedAccounts = {
    receivable: await create('psp_receivable', 'asset'),
    fees: await create('platform_fees', 'revenue'),
    pspFees: await create('psp_fees', 'expense'),
    merchants: [],
  }
  for (let i = 0; i < merchants; i++) accounts.merchants.push(await create(`merchant:wash_${i}`, 'liability'))
  return accounts
}

export function grossOf(journal: number): number {
  const gross = PRICES[journal % PRICES.length]
  if (gross === undefined) throw new Error(`no gross amount for journal ${journal}`)
  return gross
}

async function hasEntryCurrency(admin: pg.Pool): Promise<boolean> {
  const { present } = firstRow(
    await admin.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'entries'::regclass AND attname = 'currency' AND NOT attisdropped) AS present`,
    ),
  )
  return present
}

export async function seedJournals(admin: pg.Pool, accounts: SeedAccounts, from: number, to: number, options: { queueAudit: boolean }): Promise<number> {
  const started = performance.now()
  const currency = await hasEntryCurrency(admin)
  for (let start = from; start < to; start += BATCH) {
    const end = Math.min(start + BATCH, to) - 1
    await withTransaction(admin, async (client) => {
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        `WITH j AS (
           INSERT INTO journals (external_ref) SELECT 'seed:' || g FROM generate_series($1::bigint, $2::bigint) g RETURNING id, external_ref
         ), n AS (
           SELECT id, substr(external_ref, 6)::bigint AS g, (ARRAY[${PRICES.join(', ')}])[1 + substr(external_ref, 6)::bigint % ${PRICES.length}]::bigint AS gross FROM j
         )${options.queueAudit ? ', q AS (INSERT INTO audit_queue (journal_id) SELECT id FROM n)' : ''}
         INSERT INTO entries (journal_id, account_id, amount${currency ? ', currency' : ''})
         SELECT n.id, x.account_id, x.amount${currency ? `, 'EUR'` : ''}
         FROM n CROSS JOIN LATERAL (VALUES
           ($3::bigint, n.gross),
           (($6::bigint[])[1 + n.g % ${accounts.merchants.length}], -(n.gross - (n.gross * 2 / 100 + 10))),
           ($4::bigint, -(n.gross * 2 / 100 + 10) + CASE WHEN n.g % 3 = 0 THEN 8 ELSE 0 END),
           (CASE WHEN n.g % 3 = 0 THEN $5::bigint END, -8::bigint)
         ) AS x(account_id, amount)
         WHERE x.account_id IS NOT NULL`,
        [start, end, accounts.receivable, accounts.fees, accounts.pspFees, accounts.merchants],
      )
    })
  }
  await admin.query(`ANALYZE journals, entries${options.queueAudit ? ', audit_queue' : ''}`)
  return performance.now() - started
}
