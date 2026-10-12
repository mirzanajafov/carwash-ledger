export type PaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'canceled' | 'failed'
export type CardAttemptKind = 'authorize' | 'capture' | 'cancel'
export type AnswerStatus = 'succeeded' | 'declined'

const NEXT: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ['authorized', 'failed'],
  authorized: ['captured', 'canceled', 'failed'],
  captured: ['refunded'],
  refunded: [],
  canceled: [],
  failed: [],
}

export function canMove(from: PaymentStatus, to: PaymentStatus): boolean {
  return NEXT[from].includes(to)
}

export function isFinal(status: PaymentStatus): boolean {
  return NEXT[status].length === 0
}

export type Resolution = { kind: 'move'; from: PaymentStatus; to: PaymentStatus } | { kind: 'anomaly'; reason: string }

const EXPECTED_FROM: Record<CardAttemptKind, PaymentStatus> = {
  authorize: 'created',
  capture: 'authorized',
  cancel: 'authorized',
}

export function resolveCardAttempt(
  current: PaymentStatus,
  kind: CardAttemptKind,
  status: AnswerStatus,
  reason: string | null,
): Resolution {
  const from = EXPECTED_FROM[kind]
  if (current !== from) return { kind: 'anomaly', reason: `${kind} ${status} while the payment is ${current}` }
  if (status === 'succeeded') {
    const to: PaymentStatus = kind === 'authorize' ? 'authorized' : kind === 'capture' ? 'captured' : 'canceled'
    return { kind: 'move', from, to }
  }
  if (kind === 'authorize' || (kind === 'capture' && reason === 'authorization_expired')) return { kind: 'move', from, to: 'failed' }
  return { kind: 'anomaly', reason: `${kind} declined with ${reason ?? 'no reason'}` }
}
