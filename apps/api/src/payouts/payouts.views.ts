import { unixSeconds } from '../http/unix-time.ts'
import type { PayoutRecord } from './payouts.repository.ts'

export function payoutView(o: PayoutRecord) {
  return {
    id: o.id,
    object: 'payout',
    merchant: o.merchant_code,
    amount: Number(o.amount),
    currency: o.currency,
    status: o.status,
    failure_reason: o.failure_reason,
    created: unixSeconds(o.created_at),
  }
}
