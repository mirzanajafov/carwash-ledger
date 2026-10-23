import * as z from 'zod/mini'
import { PaymentView } from './payments.ts'

export const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

export type ErrorBody = z.infer<typeof ErrorBody>

export const FailedPayment = z.extend(ErrorBody, { payment: PaymentView })

export type FailedPayment = z.infer<typeof FailedPayment>

export function errorOf(body: unknown): ErrorBody['error'] | undefined {
  const parsed = ErrorBody.safeParse(body)
  return parsed.success ? parsed.data.error : undefined
}
