import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_TOLERANCE_SECONDS = 300

export function verifySignature(secret: string, body: string, header: string, nowSeconds: number): boolean {
  let timestamp: number | undefined
  let signature: string | undefined
  for (const part of header.split(',')) {
    const [name, value] = part.split('=', 2)
    if (name === 't') timestamp = Number(value)
    else if (name === 'v1') signature = value
  }
  if (timestamp === undefined || !Number.isSafeInteger(timestamp) || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest()
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'))
}
