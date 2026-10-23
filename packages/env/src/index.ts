export type Env = Readonly<Record<string, string | undefined>>

export function required(env: Env, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function optional(env: Env, name: string): string | undefined {
  return env[name] || undefined
}

export function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

export function positiveInteger(env: Env, name: string, fallback: number): number {
  const value = integer(env, name, fallback)
  if (value === 0) throw new Error(`${name} must be a positive integer`)
  return value
}
