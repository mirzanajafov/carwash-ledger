import type { PayoutId } from '../ids.ts'

export type PayoutStatus = 'pending' | 'succeeded' | 'failed'

export interface Payout {
  id: PayoutId
  merchantCode: string
  merchantAccountId: bigint
  amount: bigint
  currency: string
  status: PayoutStatus
  failureReason: string | null
  journalId: bigint
  createdAt: Date
}
