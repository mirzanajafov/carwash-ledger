import { TOPICS, writeEvent, writeJournalEvents } from '@carwash/outbox'
import type { Transaction } from '@carwash/pg'
import { loadPayment, loadRefund } from '../payments/payments.repository.ts'
import { paymentView, refundView } from '../payments/payments.views.ts'

export async function paymentEvent(client: Transaction, paymentId: string, type: string): Promise<void> {
  const payment = (await loadPayment(client, paymentId))!
  await writeEvent(client, { topic: TOPICS.payments, key: payment.id, type, payload: paymentView(payment) })
}

export async function refundEvent(client: Transaction, refundId: string, type: string): Promise<void> {
  const refund = (await loadRefund(client, refundId))!
  await writeEvent(client, { topic: TOPICS.payments, key: refund.payment_id, type, payload: refundView(refund) })
}

export async function journalEvents(client: Transaction, journalId: bigint): Promise<void> {
  await writeJournalEvents(client, journalId)
}
