const SQLSTATE = /^[0-9A-Z]{5}$/

interface ErrorLike {
  code?: unknown
  constraint?: unknown
  cause?: unknown
  message?: unknown
}

function* chain(error: unknown): Generator<ErrorLike> {
  const seen = new Set<unknown>()
  for (let current = error; current !== null && typeof current === 'object' && !seen.has(current);) {
    seen.add(current)
    const e = current as ErrorLike
    yield e
    current = e.cause
  }
}

export function sqlStateOf(error: unknown): string | undefined {
  for (const e of chain(error)) if (typeof e.code === 'string' && SQLSTATE.test(e.code)) return e.code
  return undefined
}

export function constraintOf(error: unknown): string | undefined {
  for (const e of chain(error)) if (typeof e.constraint === 'string') return e.constraint
  return undefined
}

export function errorText(error: unknown): string {
  const parts: string[] = []
  for (const e of chain(error)) {
    for (const value of [e.message, e.constraint]) if (typeof value === 'string') parts.push(value)
  }
  return parts.join(' | ')
}
