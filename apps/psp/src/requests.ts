import * as z from 'zod/mini'

export const MAX_AMOUNT = 100_000_000_000

function amount(name: string) {
  const error = `${name} must be an integer from 1 to ${MAX_AMOUNT} in minor units`
  return z.int({ error }).check(z.gte(1, { error }), z.lte(MAX_AMOUNT, { error }))
}

function currency(name: string) {
  const error = `${name} must be a three-letter currency code`
  return z.string({ error }).check(z.regex(/^[A-Z]{3}$/, { error }))
}

function text(name: string, maxLength = 200) {
  const error = `${name} must be a string of 1 to ${maxLength} characters`
  return z.string({ error }).check(z.minLength(1, { error }), z.maxLength(maxLength, { error }))
}

function body<Shape extends Record<string, z.ZodMiniType>>(shape: Shape) {
  return z.strictObject(shape, {
    error: (issue) => (issue.code === 'unrecognized_keys' ? `unknown field ${issue.keys.join(', ')}` : 'the body must be a JSON object'),
  })
}

export const ChargeRequest = body({ amount: amount('amount'), currency: currency('currency'), token: text('token') })
export const PayoutRequest = body({ amount: amount('amount'), currency: currency('currency'), destination: text('destination') })
export const CaptureRequest = body({ amount: z.optional(amount('amount')) })
export const CancelRequest = body({})
export const RefundRequest = body({ amount: amount('amount') })
