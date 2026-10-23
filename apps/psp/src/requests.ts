import { onlyFields } from '@carwash/http'
import * as z from 'zod/mini'

const MAX_AMOUNT = 100_000_000_000

function amount(name: string) {
  const error = `${name} must be an integer from 1 to ${MAX_AMOUNT} in minor units`
  return z.int({ error }).check(z.gte(1, { error }), z.lte(MAX_AMOUNT, { error }))
}

function currency(name: string) {
  const error = `${name} must be a three-letter currency code`
  return z.string({ error }).check(z.regex(/^[A-Z]{3}$/, { error }))
}

function boundedText(name: string, maxLength = 200) {
  const error = `${name} must be a string of 1 to ${maxLength} characters`
  return z.string({ error }).check(z.minLength(1, { error }), z.maxLength(maxLength, { error }))
}

function strictBody<Shape extends Record<string, z.ZodMiniType>>(shape: Shape) {
  return onlyFields(shape, 'unknown field', 'the body must be a JSON object')
}

export const ChargeRequest = strictBody({ amount: amount('amount'), currency: currency('currency'), token: boundedText('token') })
export const PayoutRequest = strictBody({ amount: amount('amount'), currency: currency('currency'), destination: boundedText('destination') })
export const CaptureRequest = strictBody({ amount: z.optional(amount('amount')) })
export const CancelRequest = strictBody({})
export const RefundRequest = strictBody({ amount: amount('amount') })
