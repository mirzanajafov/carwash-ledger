import type { PayoutView } from '@carwash/contracts'
import { unixSeconds } from '../unix-time.ts'
import type { Payout } from './payout.ts'

export function payoutView(o: Payout): PayoutView {
  return {
    id: o.id,
    object: 'payout',
    merchant: o.merchantCode,
    amount: Number(o.amount),
    currency: o.currency,
    status: o.status,
    failure_reason: o.failureReason,
    created: unixSeconds(o.createdAt),
  }
}
