import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADER = 'psp-signature'

function digest(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

export function signatureHeader(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${digest(secret, timestamp, body)}`
}

export function verifySignature(secret: string, body: string, header: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  const parts = new Map(header.split(',').map((part) => part.split('=', 2) as [string, string]))
  const timestamp = Number(parts.get('t'))
  const signature = parts.get('v1')
  if (!Number.isSafeInteger(timestamp) || !signature || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false
  const expected = Buffer.from(digest(secret, timestamp, body), 'hex')
  const actual = Buffer.from(signature, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
