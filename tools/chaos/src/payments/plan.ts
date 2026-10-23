import { PROGRAMS } from '@carwash/contracts'
import { between, mulberry32, pick, type Random } from '@carwash/lab'
import { arrivals, TOXIC_KINDS, type ToxicKind } from '../plan.ts'

export const SERVICES = ['api-0', 'api-1', 'worker', 'witness'] as const
export type ServiceName = (typeof SERVICES)[number]

export const PROXIES = ['api-0-db', 'api-1-db', 'worker-db', 'psp', 'webhooks', 'worker-kafka', 'witness'] as const
export type ProxyName = (typeof PROXIES)[number]

const PROXY_WEIGHTS: Record<ProxyName, number> = {
  'api-0-db': 0.2,
  'api-1-db': 0.2,
  'worker-db': 0.15,
  psp: 0.3,
  webhooks: 0.15,
  'worker-kafka': 0.15,
  witness: 0.1,
}

export const PRICES = PROGRAMS.map((program) => program.price)

export interface PaymentJourney {
  at: number
  index: number
  client: number
  merchant: number
  amount: number
  capture: 'auto' | 'manual'
  settle: 'capture' | 'cancel'
  captureAmount: number
  refunds: number[]
  pauses: number[]
  duplicate: boolean
  reuse: boolean
  rival: boolean
}

export interface PlannedPayout {
  at: number
  index: number
  merchant: number
  duplicate: boolean
}

export type PaymentFault =
  | { at: number; kind: 'kill'; target: ServiceName }
  | { at: number; kind: 'postgres'; downMs: number }
  | { at: number; kind: 'kafka'; downMs: number }
  | { at: number; kind: 'toxic'; proxy: ProxyName; toxic: ToxicKind; lastsMs: number }

export interface PaymentsPlanOptions {
  seed: number
  durationMs: number
  rate: number
  clients: number
  merchants: number
  manualShare: number
  cancelShare: number
  partialShare: number
  refundShare: number
  duplicateShare: number
  reuseShare: number
  rivalShare: number
  payoutEveryMs: number
  killEveryMs: number
  postgresEveryMs: number
  kafkaEveryMs: number
  toxicEveryMs: number
  forgeEveryMs: number
}

export interface PaymentsPlan {
  journeys: PaymentJourney[]
  payouts: PlannedPayout[]
  faults: PaymentFault[]
  forgeries: number[]
}

export function split(random: Random, total: number, parts: number): number[] {
  if (parts <= 1 || total < parts) return [total]
  const cuts = new Set<number>()
  while (cuts.size < parts - 1) cuts.add(between(random, 1, total - 1))
  const sorted = [...cuts].sort((a, b) => a - b)
  return [...sorted, total].map((cut, i) => cut - (sorted[i - 1] ?? 0))
}

function weighted<T extends string>(random: Random, weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][]
  let left = random() * entries.reduce((sum, [, w]) => sum + w, 0)
  for (const [name, weight] of entries) {
    left -= weight
    if (left < 0) return name
  }
  const last = entries.at(-1)
  if (last === undefined) throw new Error('there are no weights to choose from')
  return last[0]
}

function journey(random: Random, options: PaymentsPlanOptions, at: number, index: number): PaymentJourney {
  const amount = pick(random, PRICES)
  const manual = random() < options.manualShare
  const cancel = manual && random() < options.cancelShare
  const captureAmount = manual && !cancel && random() < options.partialShare ? between(random, Math.ceil(amount / 2), amount - 1) : amount
  let refunds: number[] = []
  if (!cancel && random() < options.refundShare) {
    const full = random() < 0.4
    const total = full ? captureAmount : between(random, Math.ceil(captureAmount / 5), Math.floor((captureAmount * 9) / 10))
    refunds = split(random, total, between(random, 1, 3))
  }
  return {
    at,
    index,
    client: Math.floor(random() * options.clients),
    merchant: Math.floor(random() * options.merchants),
    amount,
    capture: manual ? 'manual' : 'auto',
    settle: cancel ? 'cancel' : 'capture',
    captureAmount,
    refunds,
    pauses: Array.from({ length: 1 + refunds.length }, () => between(random, 50, 1500)),
    duplicate: random() < options.duplicateShare,
    reuse: random() < options.reuseShare,
    rival: manual && !cancel && random() < options.rivalShare,
  }
}

export function planPayments(options: PaymentsPlanOptions): PaymentsPlan {
  const journeyRandom = mulberry32(options.seed)
  const journeys = arrivals(journeyRandom, 1000 / options.rate, options.durationMs).map((at, i) => journey(journeyRandom, options, at, i))

  const payoutRandom = mulberry32(options.seed ^ 0x7061796f)
  const payouts = arrivals(payoutRandom, options.payoutEveryMs, options.durationMs).map((at, index) => ({
    at,
    index,
    merchant: Math.floor(payoutRandom() * options.merchants),
    duplicate: payoutRandom() < options.duplicateShare,
  }))

  const killRandom = mulberry32(options.seed ^ 0x6b696c6c)
  const kills: PaymentFault[] = arrivals(killRandom, options.killEveryMs, options.durationMs).map((at) => ({
    at,
    kind: 'kill',
    target: pick(killRandom, SERVICES),
  }))

  const postgresRandom = mulberry32(options.seed ^ 0x70677371)
  const postgres: PaymentFault[] = arrivals(postgresRandom, options.postgresEveryMs, options.durationMs).map((at) => ({
    at,
    kind: 'postgres',
    downMs: between(postgresRandom, 200, 2000),
  }))

  const kafkaRandom = mulberry32(options.seed ^ 0x6b61666b)
  const kafka: PaymentFault[] =
    options.kafkaEveryMs > 0
      ? arrivals(kafkaRandom, options.kafkaEveryMs, options.durationMs).map((at) => ({ at, kind: 'kafka', downMs: between(kafkaRandom, 200, 5000) }))
      : []

  const toxicRandom = mulberry32(options.seed ^ 0x746f7869)
  const toxics: PaymentFault[] = arrivals(toxicRandom, options.toxicEveryMs, options.durationMs).map((at) => ({
    at,
    kind: 'toxic',
    proxy: weighted(toxicRandom, PROXY_WEIGHTS),
    toxic: pick(toxicRandom, TOXIC_KINDS),
    lastsMs: between(toxicRandom, 300, 3000),
  }))

  const forgeries = arrivals(mulberry32(options.seed ^ 0x666f7267), options.forgeEveryMs, options.durationMs)

  return { journeys, payouts, faults: [...kills, ...postgres, ...kafka, ...toxics].sort((a, b) => a.at - b.at), forgeries }
}
