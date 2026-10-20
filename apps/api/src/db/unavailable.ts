const CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', '53300', '57P01', '57P02', '57P03', '25P03', '25P04'])

const MESSAGES = ['Connection terminated', 'timeout exceeded when trying to connect', 'Query read timeout', 'Client has encountered a connection error']

export function databaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && (CODES.has(code) || code.startsWith('08'))) return true
  return MESSAGES.some((message) => error.message.startsWith(message))
}
