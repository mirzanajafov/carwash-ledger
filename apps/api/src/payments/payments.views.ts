import { unixSeconds } from '../unix-time.ts'
import type { Payment, Refund } from './payment.ts'

export function paymentView(p: Payment) {
  return {
    id: p.id,
    object: 'payment',
    merchant: p.merchantCode,
    amount: Number(p.amount),
    currency: p.currency,
    capture_mode: p.captureMode,
    status: p.status,
    captured_amount: Number(p.capturedAmount),
    refunded_amount: Number(p.refundedAmount),
    fee: Number(p.fee),
    failure_reason: p.failureReason,
    created: unixSeconds(p.createdAt),
  }
}

export function refundView(r: Refund) {
  return {
    id: r.id,
    object: 'refund',
    payment: r.paymentId,
    amount: Number(r.amount),
    status: r.status,
    fee_refund: Number(r.feeRefund),
    failure_reason: r.failureReason,
    created: unixSeconds(r.createdAt),
  }
}
