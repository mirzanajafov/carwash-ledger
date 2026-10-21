import { createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { checkpointBody, Frontier, ORIGIN, toHex } from '@carwash/audit'
import { sequenceBatch, treeSize } from '@carwash/audit-pg'
import { createAccount, type Account } from '@carwash/ledger'
import { checkout } from '@carwash/pg'
import type pg from 'pg'

export interface Shape {
  days: number
  paymentsPerDay: number
  leavesPerCheckpoint: number
}

export interface Witnessing {
  origin: string
  publicKey: string
  key: KeyObject
  latest: { size: number; root: string; signature: string }
}

export interface ProductionLedger {
  payments: number
  journals: number
  checkpoints: number
  witness: Witnessing
  ms: { rows: number; sequencer: number; checkpoints: number }
}

const MERCHANTS = ['wash_north', 'wash_south', 'wash_east']
const BATCH = 18_000
const BLOCK = 180

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
    INSERT INTO refunds (payment_id, amount, status, fee_refund, failure_reason, created_at, resolved_at)
    SELECT id, refund, CASE WHEN refund_fails THEN 'failed' ELSE 'succeeded' END::refund_status,
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
    INSERT INTO payouts (merchant_id, amount, currency, status, created_at, resolved_at)
    SELECT merchant_id, amount, 'EUR', 'succeeded', created_at, created_at FROM due WHERE amount > 0 ORDER BY block, merchant_id
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
  ) k`

const BALANCES = `
  UPDATE balances b SET amount = t.total
  FROM (SELECT account_id, sum(amount) AS total FROM entries GROUP BY account_id) t
  WHERE b.account_id = t.account_id AND b.shard = 0`

async function inTransaction(admin: pg.Pool, work: (client: pg.ClientBase) => Promise<void>): Promise<void> {
  const lease = await checkout(admin)
  let broken = false
  try {
    await lease.client.query('BEGIN')
    await lease.client.query('SET LOCAL session_replication_role = replica')
    await work(lease.client)
    await lease.client.query('COMMIT')
  } catch (error) {
    await lease.client.query('ROLLBACK').catch(() => {
      broken = true
    })
    throw error
  } finally {
    lease.release(broken)
  }
}

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
  for (;;) {
    let sequenced = 0
    await inTransaction(app, async (client) => {
      sequenced = await sequenceBatch(client, 1000)
    })
    if (sequenced === 0) return
  }
}

async function signCopies(admin: pg.Pool, size: number, leavesPerCheckpoint: number): Promise<Witnessing & { count: number }> {
  const { privateKey } = generateKeyPairSync('ed25519')
  const publicKey = createPublicKey(privateKey)
  const { x } = publicKey.export({ format: 'jwk' })
  if (!x) throw new Error('an Ed25519 key exports its public half as x')
  const frontier = new Frontier()
  let next = 1
  let count = 0
  let latest: Witnessing['latest'] | undefined
  for (let from = 0; from < size; from += 50_000) {
    const { rows } = await admin.query<{ leaf: Buffer }>('SELECT a.leaf FROM audit_log a WHERE a.seq >= $1 AND a.seq < $2 ORDER BY a.seq', [
      from,
      from + 50_000,
    ])
    const copies: { size: number; root: Buffer; signature: Buffer }[] = []
    for (const row of rows) {
      frontier.push(new Uint8Array(row.leaf))
      if (frontier.size < Math.round(next * leavesPerCheckpoint) && frontier.size !== size) continue
      next++
      const root = toHex(frontier.root())
      const signature = sign(null, Buffer.from(checkpointBody({ size: frontier.size, root })), privateKey)
      copies.push({ size: frontier.size, root: Buffer.from(root, 'hex'), signature })
      latest = { size: frontier.size, root, signature: signature.toString('base64') }
    }
    await admin.query(
      `INSERT INTO audit_checkpoints (size, root, signature, witness_key, signed_at)
       SELECT size, root, signature, $4, now() FROM unnest($1::bigint[], $2::bytea[], $3::bytea[]) AS c(size, root, signature)`,
      [copies.map((c) => c.size), copies.map((c) => c.root), copies.map((c) => c.signature), x],
    )
    count += copies.length
  }
  if (!latest) throw new Error('the audit log is empty')
  return { origin: ORIGIN, publicKey: x, key: publicKey, latest, count }
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
  const clients = await admin.query<{ id: string }>(
    `INSERT INTO api_clients (name, key_hash, scope) VALUES ('traffic', $1, 'client'), ('admin', $2, 'admin') RETURNING id::text`,
    [randomBytes(32), randomBytes(32)],
  )
  const [traffic, adminClient] = clients.rows.map((row) => row.id)
  const payments = Math.round(shape.days * shape.paymentsPerDay)
  const spacing = 86_400 / shape.paymentsPerDay
  const start = new Date(Date.now() - payments * spacing * 1000 - 60_000)
  const receivable = accounts.receivable.id.toString()
  const fees = accounts.fees.id.toString()
  const bank = accounts.bank.id.toString()
  for (let from = 0; from < payments; from += BATCH) {
    await inTransaction(admin, async (client) => {
      await client.query(BATCH_ROWS, [from, Math.min(from + BATCH, payments) - 1, start, spacing, merchants.map((m) => m.id), merchants.map((m) => m.account)])
      await client.query(PAYMENTS, [traffic])
      await client.query(CAPTURES, [receivable, fees])
      await client.query(REFUNDS, [receivable, fees])
      await client.query(PAYOUTS, [bank])
    })
  }
  await inTransaction(admin, async (client) => {
    await client.query(KEYS, [traffic, adminClient])
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
    ms: { rows: Math.round(rowsMs), sequencer: Math.round(sequencedMs), checkpoints: Math.round(performance.now() - started - rowsMs - sequencedMs) },
  }
}
