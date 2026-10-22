import type { AttemptId, PaymentId, PayoutId, RefundId } from '../ids.ts'
import type { AnswerStatus } from '../psp/answers.ts'

export type CardAttemptKind = 'authorize' | 'capture' | 'cancel'
export type AttemptStatus = 'pending' | AnswerStatus

interface AttemptFields {
  id: AttemptId
  status: AttemptStatus
  amount: bigint
  currency: string
  pspOperationId: string | null
  declineReason: string | null
}

export type CardAttempt = AttemptFields & { kind: CardAttemptKind; paymentId: PaymentId }
export type RefundAttempt = AttemptFields & { kind: 'refund'; paymentId: PaymentId; refundId: RefundId }
export type PayoutAttempt = AttemptFields & { kind: 'payout'; payoutId: PayoutId }
export type Attempt = CardAttempt | RefundAttempt | PayoutAttempt
