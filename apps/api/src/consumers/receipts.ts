import { PaymentEventData } from '@carwash/contracts'
import { TOPICS, type ConsumerSpec } from '@carwash/outbox'

const CapturedPayment = PaymentEventData.pick({ id: true, merchant: true, captured_amount: true, fee: true, currency: true })

const ISSUE = `
  WITH counter AS (
    INSERT INTO receipt_counters (merchant, last_number) VALUES ($1, 1)
    ON CONFLICT (merchant) DO UPDATE SET last_number = receipt_counters.last_number + 1
    RETURNING last_number
  )
  INSERT INTO receipts (merchant, number, payment_id, amount, fee, currency, captured_at, event_id)
  SELECT $1, last_number, $2, $3, $4, $5, $6, $7 FROM counter`

export const receipts: ConsumerSpec = {
  name: 'receipts',
  topic: TOPICS.payments,
  apply: async (client, events) => {
    const captured = events
      .filter((event) => event.type === 'payment.captured')
      .map((event) => ({ event, payment: CapturedPayment.parse(event.data) }))
      .sort((a, b) => a.payment.merchant.localeCompare(b.payment.merchant))
    for (const { event, payment } of captured) {
      await client.query(ISSUE, [payment.merchant, payment.id, payment.captured_amount, payment.fee, payment.currency, event.occurredAt, event.id])
    }
  },
}
