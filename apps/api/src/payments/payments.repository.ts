import { firstRow, type Queryable, type Transaction } from '@carwash/pg'
import { asPaymentId, asRefundId, type PaymentId, type RefundId } from '../ids.ts'
import type { CaptureMode, Payment, PaymentStatus, Refund, RefundStatus } from './payment.ts'

export interface NewPayment {
  clientId: string
  merchantId: string
  amount: bigint
  currency: string
  capture: CaptureMode
  token: string
}

export interface PaymentChanges {
  failureReason?: string
  pspChargeId?: string | null
  capturedAmount?: bigint
  fee?: bigint
  captureJournalId?: bigint
  refundedAmount?: bigint
}

interface PaymentRow {
  id: string
  client_id: string
  merchant_code: string
  merchant_account_id: string
  amount: string
  currency: string
  capture_mode: CaptureMode
  status: PaymentStatus
  token: string
  psp_charge_id: string | null
  captured_amount: string
  refunded_amount: string
  fee: string
  failure_reason: string | null
  created_at: Date
}

interface RefundRow {
  id: string
  payment_id: string
  amount: string
  status: RefundStatus
  fee_refund: string
  failure_reason: string | null
  created_at: Date
}

const PAYMENT = `
SELECT p.id, p.client_id::text, m.code AS merchant_code, m.account_id::text AS merchant_account_id, p.amount::text, p.currency,
       p.capture_mode::text, p.status::text, p.token, p.psp_charge_id, p.captured_amount::text, p.refunded_amount::text,
       p.fee::text, p.failure_reason, p.created_at
FROM payments p JOIN merchants m ON m.id = p.merchant_id
WHERE p.id = $1`

const REFUND = 'SELECT id, payment_id, amount::text, status::text, fee_refund::text, failure_reason, created_at FROM refunds WHERE id = $1'

function toPayment(row: PaymentRow): Payment {
  return {
    id: asPaymentId(row.id),
    clientId: row.client_id,
    merchantCode: row.merchant_code,
    merchantAccountId: BigInt(row.merchant_account_id),
    amount: BigInt(row.amount),
    currency: row.currency,
    captureMode: row.capture_mode,
    status: row.status,
    token: row.token,
    pspChargeId: row.psp_charge_id,
    capturedAmount: BigInt(row.captured_amount),
    refundedAmount: BigInt(row.refunded_amount),
    fee: BigInt(row.fee),
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  }
}

function toRefund(row: RefundRow): Refund {
  return {
    id: asRefundId(row.id),
    paymentId: asPaymentId(row.payment_id),
    amount: BigInt(row.amount),
    status: row.status,
    feeRefund: BigInt(row.fee_refund),
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  }
}

export async function findPayment(db: Queryable, id: string): Promise<Payment | undefined> {
  const [row] = (await db.query<PaymentRow>(PAYMENT, [id])).rows
  return row && toPayment(row)
}

export async function findPaymentForUpdate(client: Transaction, id: string): Promise<Payment | undefined> {
  const [row] = (await client.query<PaymentRow>(`${PAYMENT} FOR UPDATE OF p`, [id])).rows
  return row && toPayment(row)
}

export async function loadPayment(db: Queryable, id: PaymentId): Promise<Payment> {
  return toPayment(firstRow(await db.query<PaymentRow>(PAYMENT, [id]), `payment ${id} does not exist`))
}

export async function lockPayment(client: Transaction, id: PaymentId): Promise<Payment> {
  return toPayment(firstRow(await client.query<PaymentRow>(`${PAYMENT} FOR UPDATE OF p`, [id]), `payment ${id} does not exist`))
}

export async function insertPayment(client: Transaction, payment: NewPayment): Promise<PaymentId> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO payments (client_id, merchant_id, amount, currency, capture_mode, token)
     VALUES ($1, $2, $3, $4, $5::capture_mode, $6) RETURNING id`,
    [payment.clientId, payment.merchantId, payment.amount, payment.currency, payment.capture, payment.token],
  )
  return asPaymentId(firstRow(inserted).id)
}

export async function movePayment(client: Transaction, id: PaymentId, from: PaymentStatus, to: PaymentStatus, changes: PaymentChanges): Promise<boolean> {
  const moved = await client.query(
    `UPDATE payments SET status = $3::payment_status, updated_at = now(),
       failure_reason = coalesce($4, failure_reason), psp_charge_id = coalesce($5, psp_charge_id),
       captured_amount = coalesce($6, captured_amount), fee = coalesce($7, fee),
       capture_journal_id = coalesce($8, capture_journal_id), refunded_amount = coalesce($9, refunded_amount)
     WHERE id = $1 AND status = $2::payment_status`,
    [
      id,
      from,
      to,
      changes.failureReason ?? null,
      changes.pspChargeId ?? null,
      changes.capturedAmount ?? null,
      changes.fee ?? null,
      changes.captureJournalId ?? null,
      changes.refundedAmount ?? null,
    ],
  )
  return moved.rowCount === 1
}

export async function setPaymentRefunded(client: Transaction, id: PaymentId, amount: bigint): Promise<void> {
  await client.query(`UPDATE payments SET refunded_amount = $2, updated_at = now() WHERE id = $1 AND status = 'captured'`, [id, amount])
}

export async function loadRefund(db: Queryable, id: RefundId): Promise<Refund> {
  return toRefund(firstRow(await db.query<RefundRow>(REFUND, [id]), `refund ${id} does not exist`))
}

export async function pendingRefundTotal(client: Transaction, paymentId: PaymentId): Promise<bigint> {
  const { pending } = firstRow(
    await client.query<{ pending: string }>(`SELECT coalesce(sum(amount), 0)::text AS pending FROM refunds WHERE payment_id = $1 AND status = 'pending'`, [
      paymentId,
    ]),
  )
  return BigInt(pending)
}

export async function insertRefund(client: Transaction, paymentId: PaymentId, amount: bigint): Promise<RefundId> {
  return asRefundId(
    firstRow(await client.query<{ id: string }>('INSERT INTO refunds (payment_id, amount) VALUES ($1, $2) RETURNING id', [paymentId, amount])).id,
  )
}

export async function lockRefund(client: Transaction, id: RefundId): Promise<void> {
  firstRow(await client.query('SELECT 1 FROM refunds WHERE id = $1 FOR UPDATE', [id]), `refund ${id} does not exist`)
}

export async function correctRefundAmount(client: Transaction, id: RefundId, amount: bigint): Promise<void> {
  await client.query(`UPDATE refunds SET amount = $2 WHERE id = $1 AND status = 'pending'`, [id, amount])
}

export async function failRefund(client: Transaction, id: RefundId, reason: string): Promise<void> {
  await client.query(`UPDATE refunds SET status = 'failed', failure_reason = $2, resolved_at = now() WHERE id = $1 AND status = 'pending'`, [id, reason])
}

export async function succeedRefund(client: Transaction, id: RefundId, feeRefund: bigint, journalId: bigint): Promise<void> {
  await client.query(`UPDATE refunds SET status = 'succeeded', fee_refund = $2, journal_id = $3, resolved_at = now() WHERE id = $1 AND status = 'pending'`, [
    id,
    feeRefund,
    journalId,
  ])
}
