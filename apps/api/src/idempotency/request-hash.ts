import { createHash } from 'node:crypto'

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function requestHash(method: string, path: string, body: unknown): Buffer {
  return createHash('sha256')
    .update(`${method} ${path}\n${canonicalJson(body)}`)
    .digest()
}
