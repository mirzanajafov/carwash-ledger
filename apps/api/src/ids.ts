declare const brand: unique symbol

export type PaymentId = string & { readonly [brand]: 'payment' }
export type RefundId = string & { readonly [brand]: 'refund' }
export type PayoutId = string & { readonly [brand]: 'payout' }
export type AttemptId = string & { readonly [brand]: 'attempt' }

export function paymentId(value: string): PaymentId {
  return value as PaymentId
}

export function refundId(value: string): RefundId {
  return value as RefundId
}

export function payoutId(value: string): PayoutId {
  return value as PayoutId
}

export function attemptId(value: string): AttemptId {
  return value as AttemptId
}
