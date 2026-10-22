import type { PaymentRecord, RefundRecord } from './payments.repository.ts'

export function seconds(date: Date): number {
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
