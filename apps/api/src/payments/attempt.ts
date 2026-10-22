import type { AttemptId, PaymentId, PayoutId, RefundId } from '../ids.ts'

export type CardAttemptKind = 'authorize' | 'capture' | 'cancel'
export type AttemptKind = CardAttemptKind | 'refund' | 'payout'
export type AnswerStatus = 'succeeded' | 'declined'
export type AttemptStatus = 'pending' | AnswerStatus

export type AttemptParent =
  { kind: CardAttemptKind; paymentId: PaymentId } | { kind: 'refund'; paymentId: PaymentId; refundId: RefundId } | { kind: 'payout'; payoutId: PayoutId }

interface AttemptFields {
  id: AttemptId
  status: AttemptStatus
  amount: bigint
  currency: string
  pspOperationId: string | null
  declineReason: string | null
}

export type Attempt = AttemptFields & AttemptParent
export type RefundAttempt = Extract<Attempt, { kind: 'refund' }>
export type PayoutAttempt = Extract<Attempt, { kind: 'payout' }>
