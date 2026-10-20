import { between, exponential, mulberry32, pick, type Random } from './random.ts'

export const TOXIC_KINDS = ['latency', 'timeout', 'reset_peer', 'limit_data', 'down'] as const

export type ToxicKind = (typeof TOXIC_KINDS)[number]

export type ProxyName = 'posters' | 'snapshots'

export type WorkerKind = 'poster' | 'snapshotter'

export type Fault =
  | { at: number; kind: 'kill'; worker: WorkerKind; index: number }
  | { at: number; kind: 'postgres'; downMs: number }
  | { at: number; kind: 'toxic'; proxy: ProxyName; toxic: ToxicKind; lastsMs: number }

export interface Journey {
  at: number
  ref: string
  merchant: number
  gross: bigint
  reverse: boolean
  duplicate: boolean
}

export interface PlanOptions {
  seed: number
  durationMs: number
  rate: number
  merchants: number
  posters: number
  reversalShare: number
  duplicateShare: number
  killEveryMs: number
  postgresEveryMs: number
  toxicEveryMs: number
}

export interface RunPlan {
  journeys: Journey[]
  faults: Fault[]
}

export function arrivals(random: Random, meanMs: number, durationMs: number): number[] {
  if (!(meanMs > 0)) return []
  const times: number[] = []
  for (let t = exponential(random, meanMs); t < durationMs; t += exponential(random, meanMs)) times.push(Math.round(t))
  return times
}

export function planRun(options: PlanOptions): RunPlan {
  const journeyRandom = mulberry32(options.seed)
  const journeys = arrivals(journeyRandom, 1000 / options.rate, options.durationMs).map((at, i) => ({
    at,
    ref: `cap:${options.seed}:${i}`,
    merchant: Math.floor(journeyRandom() * options.merchants),
    gross: BigInt(between(journeyRandom, 500, 100_000)),
    reverse: journeyRandom() < options.reversalShare,
    duplicate: journeyRandom() < options.duplicateShare,
  }))

  const killRandom = mulberry32(options.seed ^ 0x6b696c6c)
  const kills: Fault[] = arrivals(killRandom, options.killEveryMs, options.durationMs).map((at) => {
    const index = Math.floor(killRandom() * (options.posters + 1))
    return index === options.posters ? { at, kind: 'kill', worker: 'snapshotter', index: 0 } : { at, kind: 'kill', worker: 'poster', index }
  })

  const postgresRandom = mulberry32(options.seed ^ 0x70677371)
  const postgres: Fault[] = arrivals(postgresRandom, options.postgresEveryMs, options.durationMs).map((at) => ({
    at,
    kind: 'postgres',
    downMs: between(postgresRandom, 200, 2000),
  }))

  const toxicRandom = mulberry32(options.seed ^ 0x746f7869)
  const toxics: Fault[] = arrivals(toxicRandom, options.toxicEveryMs, options.durationMs).map((at) => ({
    at,
    kind: 'toxic',
    proxy: toxicRandom() < 0.8 ? 'posters' : 'snapshots',
    toxic: pick(toxicRandom, TOXIC_KINDS),
    lastsMs: between(toxicRandom, 300, 3000),
  }))

  return { journeys, faults: [...kills, ...postgres, ...toxics].sort((a, b) => a.at - b.at) }
}

export function fee(gross: bigint): bigint {
  return gross / 50n + 10n
}
