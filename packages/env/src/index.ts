export type Env = Readonly<Record<string, string | undefined>>

export function required(env: Env, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function optional(env: Env, name: string): string | undefined {
  return env[name] || undefined
}

function integerFrom(env: Env, name: string, fallback: number, min: number, kind: string): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a ${kind} integer`)
  return value
}

export function nonNegativeInteger(env: Env, name: string, fallback: number): number {
  return integerFrom(env, name, fallback, 0, 'non-negative')
}

export function positiveInteger(env: Env, name: string, fallback: number): number {
  return integerFrom(env, name, fallback, 1, 'positive')
}

export function positiveNumber(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!/^\d+(\.\d+)?$/.test(raw) || !(value > 0)) throw new Error(`${name} must be a positive number`)
  return value
}

export function oneOf<const T extends string>(env: Env, name: string, values: readonly T[], fallback: NoInfer<T>): T {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = values.find((candidate) => candidate === raw)
  if (value === undefined) throw new Error(`${name} must be one of ${values.join(', ')}`)
  return value
}

export function list(env: Env, name: string, fallback: string): string[] {
  return (env[name] || fallback)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}
