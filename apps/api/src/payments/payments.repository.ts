import { firstRow, type Queryable, type Transaction } from '@carwash/pg'
import type { PaymentStatus } from './payment-state.ts'

export interface PaymentRecord {
  id: string
  client_id: string
  merchant_code: string
  merchant_account_id: string
  amount: string
  currency: string
  capture_mode: 'auto' | 'manual'
  status: PaymentStatus
  token: string
  psp_charge_id: string | null
  captured_amount: string
  refunded_amount: string
  fee: string
  failure_reason: string | null
  created_at: Date
}

export interface RefundRecord {
  id: string
  payment_id: string
  amount: string
  status: 'pending' | 'succeeded' | 'failed'
  fee_refund: string
  failure_reason: string | null
  created_at: Date
}

export interface NewPayment {
  clientId: string
  merchantId: string
  amount: bigint
  currency: string
  capture: 'auto' | 'manual'
  token: string
}

export interface PaymentChanges {
  failure_reason?: string
  psp_charge_id?: string | null
  captured_amount?: bigint
  fee?: bigint
  capture_journal_id?: bigint
  refunded_amount?: bigint
}

const PAYMENT = `
SELECT p.id, p.client_id::text, m.code AS merchant_code, m.account_id::text AS merchant_account_id, p.amount::text, p.currency,
       p.capture_mode::text, p.status::text, p.token, p.psp_charge_id, p.captured_amount::text, p.refunded_amount::text,
       p.fee::text, p.failure_reason, p.created_at
FROM payments p JOIN merchants m ON m.id = p.merchant_id
WHERE p.id = $1`

export async function loadPayment(db: Queryable, id: string): Promise<PaymentRecord | undefined> {
  const { rows } = await db.query<PaymentRecord>(PAYMENT, [id])
  return rows[0]
}

export async function lockPayment(client: Transaction, id: string): Promise<PaymentRecord | undefined> {
  const { rows } = await client.query<PaymentRecord>(`${PAYMENT} FOR UPDATE OF p`, [id])
  return rows[0]
}

export async function insertPayment(client: Transaction, payment: NewPayment): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO payments (client_id, merchant_id, amount, currency, capture_mode, token)
     VALUES ($1, $2, $3, $4, $5::capture_mode, $6) RETURNING id`,
    [payment.clientId, payment.merchantId, payment.amount, payment.currency, payment.capture, payment.token],
  )
  return firstRow(inserted).id
}

export async function movePayment(client: Transaction, id: string, from: PaymentStatus, to: PaymentStatus, changes: PaymentChanges): Promise<boolean> {
  const set = Object.entries(changes)
  const assignments = set.map(([column], index) => `, ${column} = $${index + 4}`).join('')
  const moved = await client.query(
    `UPDATE payments SET status = $3::payment_status, updated_at = now()${assignments}
     WHERE id = $1 AND status = $2::payment_status`,
    [id, from, to, ...set.map(([, value]) => value)],
  )
  return moved.rowCount === 1
}

export async function setPaymentRefunded(client: Transaction, id: string, amount: bigint): Promise<void> {
  await client.query(`UPDATE payments SET refunded_amount = $2, updated_at = now() WHERE id = $1 AND status = 'captured'`, [id, amount])
}

export async function loadRefund(db: Queryable, id: string): Promise<RefundRecord | undefined> {
  const { rows } = await db.query<RefundRecord>(
    `SELECT id, payment_id, amount::text, status::text, fee_refund::text, failure_reason, created_at FROM refunds WHERE id = $1`,
    [id],
  )
  return rows[0]
}

export async function pendingRefundTotal(client: Transaction, paymentId: string): Promise<bigint> {
  const { pending } = firstRow(
    await client.query<{ pending: string }>(`SELECT coalesce(sum(amount), 0)::text AS pending FROM refunds WHERE payment_id = $1 AND status = 'pending'`, [
      paymentId,
    ]),
  )
  return BigInt(pending)
}

export async function insertRefund(client: Transaction, paymentId: string, amount: bigint): Promise<string> {
  return firstRow(await client.query<{ id: string }>('INSERT INTO refunds (payment_id, amount) VALUES ($1, $2) RETURNING id', [paymentId, amount])).id
}

export async function lockRefund(client: Transaction, id: string): Promise<void> {
  await client.query('SELECT 1 FROM refunds WHERE id = $1 FOR UPDATE', [id])
}

export async function correctRefundAmount(client: Transaction, id: string, amount: bigint): Promise<void> {
  await client.query(`UPDATE refunds SET amount = $2 WHERE id = $1 AND status = 'pending'`, [id, amount])
}

export async function failRefund(client: Transaction, id: string, reason: string): Promise<void> {
  await client.query(`UPDATE refunds SET status = 'failed', failure_reason = $2, resolved_at = now() WHERE id = $1 AND status = 'pending'`, [id, reason])
}

export async function succeedRefund(client: Transaction, id: string, feeRefund: bigint, journalId: bigint): Promise<void> {
  await client.query(`UPDATE refunds SET status = 'succeeded', fee_refund = $2, journal_id = $3, resolved_at = now() WHERE id = $1 AND status = 'pending'`, [
    id,
    feeRefund,
    journalId,
  ])
}
