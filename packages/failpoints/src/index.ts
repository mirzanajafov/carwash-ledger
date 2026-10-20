export const FAILPOINTS = [
  'post.after_lock',
  'post.before_commit',
  'post.after_commit',
  'snapshot.before_commit',
  'transaction.before_commit',
  'transaction.after_commit',
  'attempt.after_psp',
  'request.before_finish',
  'webhook.after_pull',
  'recovery.after_pull',
  'relay.before_produce',
  'relay.after_produce',
  'consumer.before_commit',
  'consumer.before_offset',
  'checkpoint.after_sign',
] as const

export type FailpointName = (typeof FAILPOINTS)[number]

export type FailpointAction = (name: FailpointName) => void

let armed: ReadonlyMap<FailpointName, number> = new Map()
let onHit: FailpointAction = () => undefined
let random: () => number = Math.random

export function armFailpoints(probabilities: ReadonlyMap<FailpointName, number>, action: FailpointAction, rng: () => number = Math.random): void {
  armed = new Map(probabilities)
  onHit = action
  random = rng
}

export function disarmFailpoints(): void {
  armed = new Map()
}

export function failpoint(name: FailpointName): void {
  if (armed.size === 0) return
  const probability = armed.get(name)
  if (probability !== undefined && random() < probability) onHit(name)
}

export function parseFailpoints(spec: string): Map<FailpointName, number> {
  const parsed = new Map<FailpointName, number>()
  for (const part of spec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [name, value] = part.split('=')
    if (!(FAILPOINTS as readonly string[]).includes(name!)) throw new Error(`unknown failpoint ${name}`)
    const probability = Number(value)
    if (!(probability >= 0 && probability <= 1)) throw new Error(`failpoint ${name} needs a probability in [0, 1]`)
    parsed.set(name as FailpointName, probability)
  }
  return parsed
}
