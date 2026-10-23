import { PROGRAMS } from '@carwash/contracts'
import { exponential, pick, type Random } from '@carwash/lab'

export interface Visit {
  program: string
  amount: number
  merchant: string
  token: 'tok_ok' | 'tok_decline'
  capture: 'auto' | 'manual'
  captureAfterMs: number
  refund: number
  refundAfterMs: number
}

export function visit(random: Random, merchants: readonly string[]): Visit {
  const program = pick(random, PROGRAMS)
  const manual = random() < 0.15
  const refunded = random() < 0.08
  return {
    program: program.name,
    amount: program.price,
    merchant: pick(random, merchants),
    token: random() < 0.04 ? 'tok_decline' : 'tok_ok',
    capture: manual ? 'manual' : 'auto',
    captureAfterMs: manual ? 3000 + Math.floor(random() * 5000) : 0,
    refund: refunded ? Math.max(100, Math.round((program.price * (0.2 + random() * 0.8)) / 100) * 100) : 0,
    refundAfterMs: refunded ? 10_000 + Math.floor(random() * 20_000) : 0,
  }
}

export function gapMs(random: Random, perMinute: number): number {
  return exponential(random, 60_000 / perMinute)
}
