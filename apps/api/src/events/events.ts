import { TOPICS, writeEvent, writeJournalEvents } from '@carwash/outbox'
import type pg from 'pg'
import { paymentView, refundView } from '../payments/payment.views.ts'
import { loadPayment, loadRefund } from '../payments/payments.repository.ts'

export async function paymentEvent(client: pg.ClientBase, paymentId: string, type: string): Promise<void> {
  const payment = (await loadPayment(client, paymentId))!
  await writeEvent(client, { topic: TOPICS.payments, key: payment.id, type, payload: paymentView(payment) })
}

export async function refundEvent(client: pg.ClientBase, refundId: string, type: string): Promise<void> {
  const refund = (await loadRefund(client, refundId))!
  await writeEvent(client, { topic: TOPICS.payments, key: refund.payment_id, type, payload: refundView(refund) })
}

export async function journalEvents(client: pg.ClientBase, journalId: bigint): Promise<void> {
  await writeJournalEvents(client, journalId)
}
