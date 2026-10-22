export interface Plan {
  seed?: number
  decline?: number
  fail?: number
  timeoutAfterCommit?: number
  slow?: number
  slowMs?: [number, number]
  wrongAmount?: number
  webhook?: Partial<Record<'duplicate' | 'delay' | 'reorder' | 'drop', number>>
  settlement?: Partial<Record<'nextDay' | 'feeDifference' | 'wrongAmount' | 'missingLine' | 'duplicateLine' | 'droppedReference', number>>
}

export interface Preset {
  name: 'calm' | 'flaky' | 'storm'
  title: string
  detail: string
  plan: Plan | null
}

export const PRESETS: readonly Preset[] = [
  {
    name: 'calm',
    title: 'An ordinary day',
    detail: 'The plan the bank started with: a failure, a timeout or a lost webhook now and then.',
    plan: null,
  },
  {
    name: 'flaky',
    title: 'A flaky bank',
    detail: 'One request in twenty fails or times out after doing the work, and webhooks arrive twice, late or out of order.',
    plan: {
      decline: 0.05,
      fail: 0.05,
      timeoutAfterCommit: 0.05,
      slow: 0.1,
      wrongAmount: 0.01,
      webhook: { duplicate: 0.2, delay: 0.1, reorder: 0.2, drop: 0.1 },
      settlement: { nextDay: 0.05, feeDifference: 0.02, missingLine: 0.01, duplicateLine: 0.01 },
    },
  },
  {
    name: 'storm',
    title: 'A storm',
    detail: 'Everything goes wrong at once: timeouts, slow answers, wrong amounts, lost webhooks, and a settlement file full of breaks.',
    plan: {
      decline: 0.1,
      fail: 0.15,
      timeoutAfterCommit: 0.15,
      slow: 0.3,
      wrongAmount: 0.03,
      webhook: { duplicate: 0.4, delay: 0.3, reorder: 0.4, drop: 0.3 },
      settlement: { nextDay: 0.1, feeDifference: 0.05, wrongAmount: 0.02, missingLine: 0.03, duplicateLine: 0.03, droppedReference: 0.02 },
    },
  },
]

export const VISITOR_SECONDS = 300
export const VISITOR_EVERY_MS = 60_000

export interface Weather {
  base: Plan
  weather: { label: string; plan: Plan; until: string } | null
}

export function presetNamed(name: unknown): Preset | undefined {
  return PRESETS.find((preset) => preset.name === name)
}

export class Turn {
  readonly #everyMs: number
  #last = Number.NEGATIVE_INFINITY

  constructor(everyMs: number) {
    this.#everyMs = everyMs
  }

  take(now: number): number {
    const wait = this.#last + this.#everyMs - now
    if (wait > 0) return Math.ceil(wait / 1000)
    this.#last = now
    return 0
  }
}

export function secondsLeft(until: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(until) - now) / 1000))
}

function percent(p: number): string {
  const value = p * 100
  return `${value < 1 ? value.toFixed(1) : Math.round(value)}%`
}

export function describePlan(plan: Plan): string[] {
  const parts: [number | undefined, string][] = [
    [plan.decline, 'declined'],
    [plan.fail, 'fail'],
    [plan.timeoutAfterCommit, 'time out after the work'],
    [plan.slow, 'slow'],
    [plan.wrongAmount, 'wrong amount'],
    [plan.webhook?.duplicate, 'webhooks twice'],
    [plan.webhook?.delay, 'webhooks late'],
    [plan.webhook?.reorder, 'webhooks out of order'],
    [plan.webhook?.drop, 'webhooks lost'],
  ]
  const settlement = Object.values(plan.settlement ?? {}).reduce((sum, p) => sum + p, 0)
  if (settlement > 0) parts.push([settlement, 'settlement lines off'])
  return parts.flatMap(([p, name]) => (p !== undefined && p > 0 ? [`${percent(p)} ${name}`] : []))
}
