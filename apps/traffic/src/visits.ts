export const PROGRAMS = [
  { name: 'Basic', price: 900 },
  { name: 'Foam', price: 1500 },
  { name: 'Deluxe', price: 2400 },
  { name: 'Ceramic', price: 3500 },
  { name: 'Full detail', price: 4900 },
] as const

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

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)]
  if (item === undefined) throw new Error('there is nothing to pick from')
  return item
}

export function visit(random: () => number, merchants: readonly string[]): Visit {
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

export function gapMs(random: () => number, perMinute: number): number {
  return (-Math.log(1 - random()) / perMinute) * 60_000
}
