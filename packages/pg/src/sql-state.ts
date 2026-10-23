const SQLSTATE = /^[0-9A-Z]{5}$/

const PRISMA_TO_SQLSTATE: Readonly<Record<string, string>> = {
  P2002: '23505',
  P2034: '40001',
}

interface ErrorLike {
  code?: unknown
  originalCode?: unknown
  originalMessage?: unknown
  constraint?: unknown
  clientVersion?: unknown
  meta?: unknown
  cause?: unknown
  message?: unknown
}

function* chain(error: unknown): Generator<ErrorLike> {
  const seen = new Set<unknown>()
  const queue: unknown[] = [error]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === null || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    const e = current as ErrorLike
    yield e
    queue.push(e.cause)
    if (e.meta !== null && typeof e.meta === 'object') for (const value of Object.values(e.meta)) queue.push(value)
  }
}

export function sqlStateOf(error: unknown): string | undefined {
  let prismaCode: string | undefined
  for (const e of chain(error)) {
    if (typeof e.originalCode === 'string' && SQLSTATE.test(e.originalCode)) return e.originalCode
    if (typeof e.code !== 'string') continue
    if ('clientVersion' in e) prismaCode ??= e.code
    else if (SQLSTATE.test(e.code)) return e.code
  }
  return prismaCode === undefined ? undefined : PRISMA_TO_SQLSTATE[prismaCode]
}

export function errorText(error: unknown): string {
  const parts: string[] = []
  for (const e of chain(error)) {
    for (const value of [e.message, e.originalMessage, e.constraint]) {
      if (typeof value === 'string') parts.push(value)
      else if (value !== undefined && value !== null) parts.push(JSON.stringify(value))
    }
    if (e.meta !== null && typeof e.meta === 'object' && 'target' in e.meta) parts.push(JSON.stringify(e.meta.target))
  }
  return parts.join(' | ')
}
