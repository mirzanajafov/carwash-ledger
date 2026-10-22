import { z } from 'zod'

export const Envelope = z.object({
  id: z.string(),
  type: z.string(),
  occurred_at: z.string(),
  data: z.unknown(),
})

export type Envelope = z.infer<typeof Envelope>

export const PaymentPayload = z.object({
  id: z.string(),
  object: z.literal('payment'),
  merchant: z.string(),
  amount: z.number(),
  currency: z.string(),
  capture_mode: z.enum(['auto', 'manual']),
  status: z.enum(['created', 'authorized', 'captured', 'refunded', 'canceled', 'failed']),
  captured_amount: z.number(),
  refunded_amount: z.number(),
  fee: z.number(),
  failure_reason: z.string().nullable(),
  created: z.number(),
})

export type PaymentPayload = z.infer<typeof PaymentPayload>

export type PaymentEventType = `payment.${PaymentPayload['status']}`

export const RefundPayload = z.object({
  id: z.string(),
  object: z.literal('refund'),
  payment: z.string(),
  amount: z.number(),
  status: z.enum(['pending', 'succeeded', 'failed']),
  fee_refund: z.number(),
  failure_reason: z.string().nullable(),
  created: z.number(),
})

export type RefundPayload = z.infer<typeof RefundPayload>

export type RefundEventType = 'refund.succeeded' | 'refund.failed'

export const EntryPosted = z.object({
  journal_id: z.string(),
  entry_id: z.string(),
  external_ref: z.string(),
  account_id: z.string(),
  account: z.string(),
  currency: z.string(),
  amount: z.string(),
  posted_at: z.string(),
})

export type EntryPosted = z.infer<typeof EntryPosted>
