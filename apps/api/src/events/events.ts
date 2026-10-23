import type { PaymentEventData, RefundEventData } from '@carwash/contracts'
import { TOPICS, writeEvent } from '@carwash/outbox'
import type { Transaction } from '@carwash/pg'
import type { PaymentId, RefundId } from '../ids.ts'
import type { Payment, Refund } from '../payments/payment.ts'
import { loadPayment, loadRefund } from '../payments/payments.repository.ts'
import { unixSeconds } from '../unix-time.ts'

function paymentData(p: Payment): PaymentEventData {
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

function refundData(r: Refund): RefundEventData {
  if (r.status === 'pending') throw new Error(`refund ${r.id} is still pending, so it has no event`)
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

export async function paymentEvent(client: Transaction, paymentId: PaymentId): Promise<void> {
  const data = paymentData(await loadPayment(client, paymentId))
  await writeEvent(client, { topic: TOPICS.payments, key: data.id, type: `payment.${data.status}`, payload: data })
}

export async function refundEvent(client: Transaction, refundId: RefundId): Promise<void> {
  const data = refundData(await loadRefund(client, refundId))
  await writeEvent(client, { topic: TOPICS.payments, key: data.payment, type: `refund.${data.status}`, payload: data })
}
