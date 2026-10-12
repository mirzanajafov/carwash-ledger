import type pg from 'pg'
import { ApiError } from '../http/api-error.ts'
import type { Final } from '../idempotency/idempotency.service.ts'
import type { AttemptKind } from '../psp/answers.ts'
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

export interface AttemptRecord {
  id: string
  kind: AttemptKind
  status: 'pending' | 'succeeded' | 'declined'
  payment_id: string | null
  refund_id: string | null
  payout_id: string | null
  amount: string
  currency: string
  psp_operation_id: string | null
  decline_reason: string | null
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

export interface PayoutRecord {
  id: string
  merchant_code: string
  merchant_account_id: string
  amount: string
  currency: string
  status: 'pending' | 'succeeded' | 'failed'
  failure_reason: string | null
  journal_id: string | null
  created_at: Date
}

const PAYMENT = `
SELECT p.id, p.client_id::text, m.code AS merchant_code, m.account_id::text AS merchant_account_id, p.amount::text, p.currency,
       p.capture_mode::text, p.status::text, p.token, p.psp_charge_id, p.captured_amount::text, p.refunded_amount::text,
       p.fee::text, p.failure_reason, p.created_at
FROM payments p JOIN merchants m ON m.id = p.merchant_id
WHERE p.id = $1`

const PAYOUT = `
SELECT o.id, m.code AS merchant_code, m.account_id::text AS merchant_account_id, o.amount::text, o.currency, o.status::text,
       o.failure_reason, o.journal_id::text, o.created_at
FROM payouts o JOIN merchants m ON m.id = o.merchant_id
WHERE o.id = $1`

export const ATTEMPT_COLUMNS = `id, kind::text, status::text, payment_id, refund_id, payout_id, amount::text, currency, psp_operation_id, decline_reason`

export async function loadPayment(db: pg.ClientBase | pg.Pool, id: string, lock = false): Promise<PaymentRecord | undefined> {
  const { rows } = await db.query<PaymentRecord>(`${PAYMENT}${lock ? ' FOR UPDATE OF p' : ''}`, [id])
  return rows[0]
}

export async function loadPayout(db: pg.ClientBase | pg.Pool, id: string, lock = false): Promise<PayoutRecord | undefined> {
  const { rows } = await db.query<PayoutRecord>(`${PAYOUT}${lock ? ' FOR UPDATE OF o' : ''}`, [id])
  return rows[0]
}

export async function loadRefund(db: pg.ClientBase | pg.Pool, id: string): Promise<RefundRecord | undefined> {
  const { rows } = await db.query<RefundRecord>(
    `SELECT id, payment_id, amount::text, status::text, fee_refund::text, failure_reason, created_at FROM refunds WHERE id = $1`,
    [id],
  )
  return rows[0]
}

export async function pendingAttempt(db: pg.ClientBase | pg.Pool, column: 'payment_id' | 'refund_id' | 'payout_id', id: string, kinds: readonly AttemptKind[]) {
  const { rows } = await db.query<AttemptRecord>(
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE ${column} = $1 AND kind = ANY($2::attempt_kind[]) AND status = 'pending' ORDER BY created_at LIMIT 1`,
    [id, kinds],
  )
  return rows[0]
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

export function paymentView(p: PaymentRecord) {
  return {
    id: p.id,
    object: 'payment',
    merchant: p.merchant_code,
    amount: Number(p.amount),
    currency: p.currency,
    capture_mode: p.capture_mode,
    status: p.status,
    captured_amount: Number(p.captured_amount),
    refunded_amount: Number(p.refunded_amount),
    fee: Number(p.fee),
    failure_reason: p.failure_reason,
    created: seconds(p.created_at),
  }
}

export function refundView(r: RefundRecord) {
  return {
    id: r.id,
    object: 'refund',
    payment: r.payment_id,
    amount: Number(r.amount),
    status: r.status,
    fee_refund: Number(r.fee_refund),
    failure_reason: r.failure_reason,
    created: seconds(r.created_at),
  }
}

export function payoutView(o: PayoutRecord) {
  return {
    id: o.id,
    object: 'payout',
    merchant: o.merchant_code,
    amount: Number(o.amount),
    currency: o.currency,
    status: o.status,
    failure_reason: o.failure_reason,
    created: seconds(o.created_at),
  }
}

export function paymentFinal(payment: PaymentRecord, expected: readonly PaymentStatus[]): Final {
  if (payment.status === 'failed' && expected.includes('failed')) {
    const code = payment.failure_reason ?? 'payment_failed'
    return { status: 402, body: { error: { code, message: `the payment failed: ${code}` }, payment: paymentView(payment) } }
  }
  if (!expected.includes(payment.status)) {
    throw new ApiError(502, 'psp_disagreement', `the PSP's answer left the payment ${payment.status}; it is recorded as an anomaly`)
  }
  return { status: 200, body: paymentView(payment) }
}
