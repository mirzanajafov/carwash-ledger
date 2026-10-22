import type { PaymentId, RefundId } from '../ids.ts'

export type PaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'canceled' | 'failed'
export const CAPTURE_MODES = ['auto', 'manual'] as const

export type CaptureMode = (typeof CAPTURE_MODES)[number]
export type RefundStatus = 'pending' | 'succeeded' | 'failed'

export interface Payment {
  id: PaymentId
  clientId: string
  merchantCode: string
  merchantAccountId: bigint
  amount: bigint
  currency: string
  captureMode: CaptureMode
  status: PaymentStatus
  token: string
  pspChargeId: string | null
  capturedAmount: bigint
  refundedAmount: bigint
  fee: bigint
  failureReason: string | null
  createdAt: Date
}

export interface Refund {
  id: RefundId
  paymentId: PaymentId
  amount: bigint
  status: RefundStatus
  feeRefund: bigint
  failureReason: string | null
  createdAt: Date
}
