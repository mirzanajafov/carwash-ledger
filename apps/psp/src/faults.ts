import { createHash } from 'node:crypto'

export const CARD_OPERATIONS = ['authorize', 'capture', 'cancel', 'refund'] as const
export type CardOperation = (typeof CARD_OPERATIONS)[number]
export type OperationKind = CardOperation | 'payout'

export const WEBHOOK_FAULTS = ['duplicate', 'delay', 'reorder', 'drop'] as const
export type WebhookFault = (typeof WEBHOOK_FAULTS)[number]

export interface FaultPlan {
  seed: number
  decline: number
  fail: number
  timeoutAfterCommit: number
  slow: number
  slowMs: readonly [number, number]
  wrongAmount: number
  webhook: Record<WebhookFault, number>
  settlement: Record<SettlementFault, number>
}

export const NO_FAULTS: FaultPlan = {
  seed: 0,
  decline: 0,
  fail: 0,
  timeoutAfterCommit: 0,
  slow: 0,
  slowMs: [500, 3000],
  wrongAmount: 0,
  webhook: { duplicate: 0, delay: 0, reorder: 0, drop: 0 },
  settlement: { nextDay: 0, feeDifference: 0, wrongAmount: 0, missingLine: 0, duplicateLine: 0, droppedReference: 0 },
}

export type TokenEffect =
  | { kind: 'ok' | 'decline' | 'expire_authorization' }
  | { kind: 'fail' | 'fail_once' | 'timeout_after' | 'drop_after' | 'slow' | 'wrong_amount'; operation: CardOperation }
  | { kind: 'webhook'; fault: WebhookFault }

const TOKEN =
  /^tok_(?:(ok|decline|expire_authorization)|(fail_once|fail|timeout_after|drop_after|slow|wrong_amount)_(authorize|capture|cancel|refund)|webhook_(duplicate|delay|reorder|drop))$/

export function parseToken(token: string): TokenEffect | undefined {
  const match = TOKEN.exec(token)
  if (!match) return undefined
  const [, simple, failure, operation, webhook] = match
  if (simple) return { kind: simple as 'ok' | 'decline' | 'expire_authorization' }
  if (failure) return { kind: failure as 'fail', operation: operation as CardOperation }
  return { kind: 'webhook', fault: webhook as WebhookFault }
}

export interface Behaviour {
  decline: boolean
  fail: boolean
  afterCommit: 'answer' | 'hang' | 'drop'
  slowMs: number
  wrongAmount: boolean
  webhook: ReadonlySet<WebhookFault>
  draw(name: string): number
}

const REMEMBERED_KEYS = 100_000

export const SETTLEMENT_FAULTS = ['nextDay', 'feeDifference', 'wrongAmount', 'missingLine', 'duplicateLine', 'droppedReference'] as const

export type SettlementFault = (typeof SETTLEMENT_FAULTS)[number]

export interface LineFaults {
  faults: ReadonlySet<SettlementFault>
  draw(name: string): number
}

export interface Weather {
  label: string
  plan: FaultPlan
  until: number
}

export const MAX_WEATHER_SECONDS = 3600

export class Faults {
  #base: FaultPlan
  #weather: Weather | undefined
  readonly #seen = new Map<string, number>()
  readonly #now: () => number

  constructor(plan: FaultPlan = NO_FAULTS, now: () => number = Date.now) {
    this.#base = plan
    this.#now = now
  }

  get plan(): FaultPlan {
    return this.weather?.plan ?? this.#base
  }

  set plan(plan: FaultPlan) {
    this.#base = plan
    this.#weather = undefined
  }

  get base(): FaultPlan {
    return this.#base
  }

  get weather(): Weather | undefined {
    if (this.#weather && this.#weather.until <= this.#now()) this.#weather = undefined
    return this.#weather
  }

  setWeather(label: string, plan: FaultPlan, seconds: number): Weather {
    this.#weather = { label, plan, until: this.#now() + seconds * 1000 }
    return this.#weather
  }

  clearWeather(): void {
    this.#weather = undefined
  }

  behaviour(key: string, kind: OperationKind, token: TokenEffect): Behaviour {
    const plan = this.plan
    const n = this.#count(key)
    const draw = (name: string) => unitHash(`${plan.seed}:${key}:${n}:${name}`)
    const tokenFor = (effect: TokenEffect['kind']) => token.kind === effect && 'operation' in token && token.operation === kind

    const decline =
      (kind === 'authorize' && (token.kind === 'decline' || draw('decline') < plan.decline)) ||
      (kind === 'payout' && draw('decline') < plan.decline)
    const fail = tokenFor('fail') || (tokenFor('fail_once') && n === 0) || draw('fail') < plan.fail
    let afterCommit: Behaviour['afterCommit'] = 'answer'
    if (tokenFor('timeout_after')) afterCommit = 'hang'
    else if (tokenFor('drop_after')) afterCommit = 'drop'
    else if (draw('timeout') < plan.timeoutAfterCommit) afterCommit = draw('timeout.kind') < 0.5 ? 'hang' : 'drop'
    const [low, high] = plan.slowMs
    const slowMs = tokenFor('slow') || draw('slow') < plan.slow ? low + Math.floor(draw('slow.ms') * (high - low + 1)) : 0
    const wrongAmount =
      (kind === 'capture' || kind === 'refund' || kind === 'payout') && (tokenFor('wrong_amount') || draw('wrong_amount') < plan.wrongAmount)
    const webhook = new Set<WebhookFault>()
    for (const fault of WEBHOOK_FAULTS) {
      if ((token.kind === 'webhook' && token.fault === fault) || draw(`webhook.${fault}`) < plan.webhook[fault]) webhook.add(fault)
    }
    return { decline, fail, afterCommit, slowMs, wrongAmount, webhook, draw }
  }

  settlement(operationId: string): LineFaults {
    const plan = this.plan
    const draw = (name: string) => unitHash(`${plan.seed}:${operationId}:settlement.${name}`)
    const faults = new Set<SettlementFault>()
    for (const fault of SETTLEMENT_FAULTS) if (draw(fault) < plan.settlement[fault]) faults.add(fault)
    return { faults, draw }
  }

  #count(key: string): number {
    const n = this.#seen.get(key) ?? 0
    this.#seen.delete(key)
    this.#seen.set(key, n + 1)
    if (this.#seen.size > REMEMBERED_KEYS) this.#seen.delete(this.#seen.keys().next().value!)
    return n
  }
}

export function unitHash(input: string): number {
  return createHash('sha256').update(input).digest().readUInt32BE(0) / 2 ** 32
}

export function parseFaultPlan(input: unknown): FaultPlan {
  if (typeof input !== 'object' || input === null) throw new Error('the fault plan must be an object')
  const source = input as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (!(key in NO_FAULTS)) throw new Error(`unknown fault plan field ${key}`)
  }
  const probability = (value: unknown, name: string) => {
    if (value === undefined) return 0
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new Error(`${name} must be a probability in [0, 1]`)
    return value
  }
  const seed = source.seed ?? 0
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be an integer')
  const slowMs = source.slowMs ?? NO_FAULTS.slowMs
  if (
    !Array.isArray(slowMs) ||
    slowMs.length !== 2 ||
    !slowMs.every((ms) => Number.isSafeInteger(ms) && ms >= 0) ||
    slowMs[0] > slowMs[1]
  ) {
    throw new Error('slowMs must be [low, high] in milliseconds')
  }
  const settlement = (source.settlement ?? {}) as Record<string, unknown>
  if (typeof settlement !== 'object' || settlement === null) throw new Error('settlement must be an object')
  for (const key of Object.keys(settlement)) {
    if (!(SETTLEMENT_FAULTS as readonly string[]).includes(key)) throw new Error(`unknown settlement fault ${key}`)
  }
  const webhook = (source.webhook ?? {}) as Record<string, unknown>
  if (typeof webhook !== 'object' || webhook === null) throw new Error('webhook must be an object')
  for (const key of Object.keys(webhook)) {
    if (!(WEBHOOK_FAULTS as readonly string[]).includes(key)) throw new Error(`unknown webhook fault ${key}`)
  }
  return {
    seed: seed as number,
    decline: probability(source.decline, 'decline'),
    fail: probability(source.fail, 'fail'),
    timeoutAfterCommit: probability(source.timeoutAfterCommit, 'timeoutAfterCommit'),
    slow: probability(source.slow, 'slow'),
    slowMs: [slowMs[0], slowMs[1]],
    wrongAmount: probability(source.wrongAmount, 'wrongAmount'),
    webhook: Object.fromEntries(WEBHOOK_FAULTS.map((fault) => [fault, probability(webhook[fault], `webhook.${fault}`)])) as Record<
      WebhookFault,
      number
    >,
    settlement: Object.fromEntries(SETTLEMENT_FAULTS.map((fault) => [fault, probability(settlement[fault], `settlement.${fault}`)])) as Record<
      SettlementFault,
      number
    >,
  }
}

export function parseWeather(input: unknown): { label: string; plan: FaultPlan; seconds: number } {
  if (typeof input !== 'object' || input === null) throw new Error('the weather must be an object')
  const source = input as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (!['label', 'plan', 'seconds'].includes(key)) throw new Error(`unknown weather field ${key}`)
  }
  const { label, seconds } = source
  if (typeof label !== 'string' || !/^[a-z][a-z0-9 -]{0,31}$/.test(label)) throw new Error('label must be 1-32 lowercase letters, digits, spaces or dashes')
  if (!Number.isSafeInteger(seconds) || (seconds as number) < 1 || (seconds as number) > MAX_WEATHER_SECONDS) {
    throw new Error(`seconds must be an integer from 1 to ${MAX_WEATHER_SECONDS}`)
  }
  return { label, plan: parseFaultPlan(source.plan), seconds: seconds as number }
}
