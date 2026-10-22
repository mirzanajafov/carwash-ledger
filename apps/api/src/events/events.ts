import {
  writeJournalEvents,
  writePaymentEvent,
  writeRefundEvent,
  type PaymentEventType,
  type PaymentPayload,
  type RefundEventType,
  type RefundPayload,
} from '@carwash/outbox'
import type { Transaction } from '@carwash/pg'
import { unixSeconds } from '../http/unix-time.ts'
import type { PaymentId, RefundId } from '../ids.ts'
import type { Payment, Refund } from '../payments/payment.ts'
import { loadPayment, loadRefund } from '../payments/payments.repository.ts'

function paymentPayload(p: Payment): PaymentPayload {
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

function refundPayload(r: Refund): RefundPayload {
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

export async function paymentEvent(client: Transaction, paymentId: PaymentId, type: PaymentEventType): Promise<void> {
  await writePaymentEvent(client, type, paymentPayload(await loadPayment(client, paymentId)))
}

export async function refundEvent(client: Transaction, refundId: RefundId, type: RefundEventType): Promise<void> {
  await writeRefundEvent(client, type, refundPayload(await loadRefund(client, refundId)))
}

export async function journalEvents(client: Transaction, journalId: bigint): Promise<void> {
  await writeJournalEvents(client, journalId)
}
