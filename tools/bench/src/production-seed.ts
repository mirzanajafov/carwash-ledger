import { randomBytes } from 'node:crypto'
import { sequenceBatch, treeSize } from '@carwash/audit-pg'
import type { WitnessView } from '@carwash/invariants'
import { createAccount, type Account } from '@carwash/ledger'
import { firstRow, withTransaction } from '@carwash/pg'
import { signCopies } from '@carwash/testkit'
import type pg from 'pg'
import { withTriggersOff } from './ledger-seed.ts'

export interface Shape {
  days: number
  paymentsPerDay: number
  leavesPerCheckpoint: number
}

interface Traffic {
  spacing: number
  next: number
  merchants: { id: string; account: string }[]
  receivable: string
  fees: string
  bank: string
  client: string
  admin: string
}

export interface ProductionLedger {
  payments: number
  journals: number
  checkpoints: number
  witness: WitnessView
  traffic: Traffic
  ms: { rows: number; sequencer: number; checkpoints: number }
}

const MERCHANTS = ['wash_north', 'wash_south', 'wash_east']
const BATCH = 18_000
const BLOCK = 180
const NEW_PAYMENTS_PER_LATE_REFUND = 36

const BATCH_ROWS = `
  CREATE TEMP TABLE batch ON COMMIT DROP AS
  SELECT g, t.created_at, uuidv7(t.created_at - clock_timestamp()) AS id, t.amount, s.status,
         ($5::bigint[])[1 + g % 3] AS merchant_id, ($6::bigint[])[1 + g % 3] AS account_id,
         CASE WHEN g * 31 % 100 < 15 THEN 'manual' ELSE 'auto' END::capture_mode AS capture_mode,
         CASE WHEN s.status = 'captured' THEN t.amount * 200 / 10000 + 10 ELSE 0 END AS fee,
         CASE WHEN s.status = 'captured' AND g * 17 % 100 < 8 THEN t.amount * (1 + g % 3) / 4 ELSE 0 END AS refund,
         g * 13 % 100 < 3 AS refund_fails
  FROM generate_series($1::bigint, $2::bigint) g
  CROSS JOIN LATERAL (
    SELECT $3::timestamptz + make_interval(secs => g * $4::double precision) AS created_at,
           (ARRAY[900, 1500, 2400, 3500, 4900])[1 + g * 7 % 5]::bigint AS amount,
           g * 2654435761 % 1000 AS draw
  ) t
  CROSS JOIN LATERAL (
    SELECT CASE WHEN t.draw < 40 THEN 'failed' WHEN t.draw < 43 THEN 'authorized' WHEN t.draw < 45 THEN 'canceled' ELSE 'captured' END::payment_status AS status
  ) s`

const PAYMENTS = `
  INSERT INTO payments (id, client_id, merchant_id, amount, currency, capture_mode, status, token, psp_charge_id,
                        captured_amount, refunded_amount, fee, failure_reason, created_at, updated_at)
  SELECT id, $1, merchant_id, amount, 'EUR', capture_mode, status, 'tok_ok', CASE WHEN status <> 'failed' THEN 'ch_' || g END,
         CASE WHEN status = 'captured' THEN amount ELSE 0 END, CASE WHEN refund > 0 AND NOT refund_fails THEN refund ELSE 0 END,
         fee, CASE WHEN status = 'failed' THEN 'declined' END, created_at, created_at
  FROM batch ORDER BY g`

const CAPTURES = `
  WITH j AS (
    INSERT INTO journals (external_ref, created_at)
    SELECT 'capture:' || id, created_at FROM batch WHERE status = 'captured' ORDER BY g
    RETURNING id, external_ref
  )
  INSERT INTO entries (journal_id, account_id, amount, currency)
  SELECT j.id, x.account_id, x.amount, 'EUR'
  FROM j JOIN batch b ON j.external_ref = 'capture:' || b.id
  CROSS JOIN LATERAL (VALUES ($1::bigint, b.amount), (b.account_id, -(b.amount - b.fee)), ($2::bigint, -b.fee)) AS x(account_id, amount)`

const REFUNDS = `
  WITH r AS (
    INSERT INTO refunds (id, payment_id, amount, status, fee_refund, failure_reason, created_at, resolved_at)
    SELECT uuidv7(created_at + interval '20 seconds' - clock_timestamp()), id, refund,
           CASE WHEN refund_fails THEN 'failed' ELSE 'succeeded' END::refund_status,
           CASE WHEN refund_fails THEN 0 ELSE fee * refund / amount END, CASE WHEN refund_fails THEN 'declined' END,
           created_at + interval '20 seconds', created_at + interval '21 seconds'
    FROM batch WHERE refund > 0 ORDER BY g
    RETURNING id, payment_id, amount, fee_refund, status, created_at
  ), j AS (
    INSERT INTO journals (external_ref, created_at)
    SELECT 'refund:' || id, created_at FROM r WHERE status = 'succeeded' ORDER BY created_at
    RETURNING id, external_ref
  )
  INSERT INTO entries (journal_id, account_id, amount, currency)
  SELECT j.id, x.account_id, x.amount, 'EUR'
  FROM j JOIN r ON j.external_ref = 'refund:' || r.id JOIN batch b ON b.id = r.payment_id
  CROSS JOIN LATERAL (VALUES ($1::bigint, -r.amount), (b.account_id, r.amount - r.fee_refund), ($2::bigint, r.fee_refund)) AS x(account_id, amount)`

const PAYOUTS = `
  WITH due AS (
    SELECT g / ${BLOCK} AS block, merchant_id, max(created_at) + interval '30 seconds' AS created_at,
           sum(CASE WHEN status = 'captured' THEN amount - fee ELSE 0 END)
           - sum(CASE WHEN refund > 0 AND NOT refund_fails THEN refund - fee * refund / amount ELSE 0 END) AS amount
    FROM batch GROUP BY 1, 2
  ), p AS (
    INSERT INTO payouts (id, merchant_id, amount, currency, status, created_at, resolved_at)
    SELECT uuidv7(created_at - clock_timestamp()), merchant_id, amount, 'EUR', 'succeeded', created_at, created_at
    FROM due WHERE amount > 0 ORDER BY block, merchant_id
    RETURNING id, merchant_id, amount, created_at
  ), j AS (
    INSERT INTO journals (external_ref, created_at)
    SELECT 'payout:' || p.id, p.created_at FROM p ORDER BY p.created_at, p.merchant_id
    RETURNING id, external_ref
  )
  INSERT INTO entries (journal_id, account_id, amount, currency)
  SELECT j.id, x.account_id, x.amount, 'EUR'
  FROM j JOIN p ON j.external_ref = 'payout:' || p.id JOIN merchants m ON m.id = p.merchant_id
  CROSS JOIN LATERAL (VALUES (m.account_id, p.amount), ($1::bigint, -p.amount)) AS x(account_id, amount)`

const KEYS = `
  INSERT INTO idempotency_keys (client_id, key, method, path, request_hash, state, recovery_point, payment_id, refund_id, payout_id, response_status, created_at)
  SELECT k.client_id, k.key, 'POST', k.path, sha256(convert_to(k.key, 'UTF8')), 'finished', 'finished', k.payment_id, k.refund_id, k.payout_id, 200, k.created_at
  FROM (
    SELECT $1::bigint AS client_id, 'pay-' || id AS key, '/v1/payments' AS path, id AS payment_id, NULL::uuid AS refund_id, NULL::uuid AS payout_id, created_at
    FROM payments WHERE created_at > now() - interval '1 day'
    UNION ALL
    SELECT $1, 'refund-' || id, '/v1/payments/' || payment_id || '/refunds', payment_id, id, NULL, created_at
    FROM refunds WHERE created_at > now() - interval '1 day'
    UNION ALL
    SELECT $2, 'payout-' || id, '/v1/payouts', NULL, NULL, id, created_at
    FROM payouts WHERE created_at > now() - interval '1 day'
  ) k
  ON CONFLICT DO NOTHING`

const REFUNDS_OF_OLDER_PAYMENTS = `
  WITH chosen AS (
    SELECT p.id, p.amount, p.fee, m.account_id
    FROM payments p JOIN merchants m ON m.id = p.merchant_id
    WHERE p.status = 'captured' AND p.refunded_amount = 0
    ORDER BY p.id LIMIT $3
  ), r AS (
    INSERT INTO refunds (payment_id, amount, status, fee_refund, created_at, resolved_at)
    SELECT id, amount / 4, 'succeeded', fee * (amount / 4) / amount, now(), now() FROM chosen
    RETURNING id, payment_id, amount, fee_refund
  ), j AS (
    INSERT INTO journals (external_ref) SELECT 'refund:' || id FROM r RETURNING id, external_ref
  ), e AS (
    INSERT INTO entries (journal_id, account_id, amount, currency)
    SELECT j.id, x.account_id, x.amount, 'EUR'
    FROM j JOIN r ON j.external_ref = 'refund:' || r.id JOIN chosen c ON c.id = r.payment_id
    CROSS JOIN LATERAL (VALUES ($1::bigint, -r.amount), (c.account_id, r.amount - r.fee_refund), ($2::bigint, r.fee_refund)) AS x(account_id, amount)
  )
  UPDATE payments p SET refunded_amount = r.amount FROM r WHERE p.id = r.payment_id`

const BALANCES = `
  UPDATE balances b SET amount = t.total
  FROM (SELECT account_id, sum(amount) AS total FROM entries GROUP BY account_id) t
  WHERE b.account_id = t.account_id AND b.shard = 0`

interface Chart {
  receivable: Account
  fees: Account
  bank: Account
  merchants: { code: string; account: Account }[]
}

async function chart(app: pg.Pool): Promise<Chart> {
  const hot = { currency: 'EUR', balanceMode: 'sharded' as const, shards: 16 }
  const cold = { currency: 'EUR', balanceMode: 'locked' as const }
  const receivable = await createAccount(app, { ...hot, code: 'psp_receivable:EUR', type: 'asset' })
  const fees = await createAccount(app, { ...hot, code: 'platform_fee_revenue:EUR', type: 'revenue' })
  const bank = await createAccount(app, { ...cold, code: 'bank:EUR', type: 'asset' })
  await createAccount(app, { ...cold, code: 'psp_fee_expense:EUR', type: 'expense' })
  await createAccount(app, { ...cold, code: 'suspense:EUR', type: 'liability' })
  const merchants: Chart['merchants'] = []
  for (const code of MERCHANTS) merchants.push({ code, account: await createAccount(app, { ...cold, code: `merchant_payable:${code}`, type: 'liability' }) })
  return { receivable, fees, bank, merchants }
}

async function sequenceEverything(app: pg.Pool): Promise<void> {
  let sequenced: number
  do {
    sequenced = await withTransaction(app, (client) => sequenceBatch(client, 1000))
  } while (sequenced > 0)
}

async function addPayments(client: pg.ClientBase, traffic: Traffic, count: number, start: Date): Promise<void> {
  const merchants = [traffic.merchants.map((m) => m.id), traffic.merchants.map((m) => m.account)]
  await client.query(BATCH_ROWS, [traffic.next, traffic.next + count - 1, start, traffic.spacing, ...merchants])
  await client.query(PAYMENTS, [traffic.client])
  await client.query(CAPTURES, [traffic.receivable, traffic.fees])
  await client.query(REFUNDS, [traffic.receivable, traffic.fees])
}

export async function addTraffic(admin: pg.Pool, traffic: Traffic, payments: number): Promise<void> {
  const start = new Date(Date.now() - (traffic.next + payments) * traffic.spacing * 1000)
  await withTriggersOff(admin, async (client) => {
    await addPayments(client, traffic, payments, start)
    await client.query(REFUNDS_OF_OLDER_PAYMENTS, [traffic.receivable, traffic.fees, Math.ceil(payments / NEW_PAYMENTS_PER_LATE_REFUND)])
    await client.query(KEYS, [traffic.client, traffic.admin])
    await client.query(BALANCES)
  })
  traffic.next += payments
}

export async function seedProductionLedger(admin: pg.Pool, app: pg.Pool, shape: Shape): Promise<ProductionLedger> {
  const started = performance.now()
  const accounts = await chart(app)
  const { rows: merchants } = await admin.query<{ id: string; account: string }>(
    `INSERT INTO merchants (code, name, currency, account_id)
     SELECT code, code, 'EUR', account FROM unnest($1::text[], $2::bigint[]) AS m(code, account)
     RETURNING id::text, account_id::text AS account`,
    [accounts.merchants.map((m) => m.code), accounts.merchants.map((m) => m.account.id.toString())],
  )
  const clients = firstRow(
    await admin.query<{ client: string; admin: string }>(
      `WITH c AS (
         INSERT INTO api_clients (name, key_hash, scope) VALUES ('traffic', $1, 'client'), ('admin', $2, 'admin') RETURNING id, scope
       )
       SELECT max(id) FILTER (WHERE scope = 'client')::text AS client, max(id) FILTER (WHERE scope = 'admin')::text AS admin FROM c`,
      [randomBytes(32), randomBytes(32)],
    ),
  )
  const payments = Math.round(shape.days * shape.paymentsPerDay)
  const spacing = 86_400 / shape.paymentsPerDay
  const start = new Date(Date.now() - payments * spacing * 1000 - 60_000)
  const traffic: Traffic = {
    spacing,
    next: 0,
    merchants,
    receivable: accounts.receivable.id.toString(),
    fees: accounts.fees.id.toString(),
    bank: accounts.bank.id.toString(),
    ...clients,
  }
  while (traffic.next < payments) {
    const count = Math.min(BATCH, payments - traffic.next)
    await withTriggersOff(admin, async (client) => {
      await addPayments(client, traffic, count, start)
      await client.query(PAYOUTS, [traffic.bank])
    })
    traffic.next += count
  }
  await withTriggersOff(admin, async (client) => {
    await client.query(KEYS, [traffic.client, traffic.admin])
    await client.query(BALANCES)
    await client.query('INSERT INTO audit_queue (journal_id) SELECT j.id FROM journals j ORDER BY j.id')
  })
  await admin.query('ANALYZE')
  const rowsMs = performance.now() - started
  await sequenceEverything(app)
  const sequencedMs = performance.now() - started - rowsMs
  const journals = await treeSize(admin)
  const { count, ...witness } = await signCopies(admin, journals, shape.leavesPerCheckpoint)
  await admin.query('ANALYZE')
  return {
    payments,
    journals,
    checkpoints: count,
    witness,
    traffic,
    ms: { rows: Math.round(rowsMs), sequencer: Math.round(sequencedMs), checkpoints: Math.round(performance.now() - started - rowsMs - sequencedMs) },
  }
}
