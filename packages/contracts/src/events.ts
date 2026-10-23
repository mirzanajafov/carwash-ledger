import { z } from 'zod'

const MinorUnits = z.int()
const DecimalMinorUnits = z.string().regex(/^-?\d+$/)
const DatabaseId = z.string().regex(/^\d+$/)

export const PaymentEventData = z.object({
  id: z.uuid(),
  object: z.literal('payment'),
  merchant: z.string(),
  amount: MinorUnits,
  currency: z.string(),
  capture_mode: z.enum(['auto', 'manual']),
  status: z.enum(['created', 'authorized', 'captured', 'refunded', 'canceled', 'failed']),
  captured_amount: MinorUnits,
  refunded_amount: MinorUnits,
  fee: MinorUnits,
  failure_reason: z.string().nullable(),
  created: z.int(),
})

export type PaymentEventData = z.infer<typeof PaymentEventData>

export const RefundEventData = z.object({
  id: z.uuid(),
  object: z.literal('refund'),
  payment: z.uuid(),
  amount: MinorUnits,
  status: z.enum(['succeeded', 'failed']),
  fee_refund: MinorUnits,
  failure_reason: z.string().nullable(),
  created: z.int(),
})

export type RefundEventData = z.infer<typeof RefundEventData>

export const EntryPostedData = z.object({
  journal_id: DatabaseId,
  entry_id: DatabaseId,
  external_ref: z.string(),
  account_id: DatabaseId,
  account: z.string(),
  currency: z.string(),
  amount: DecimalMinorUnits,
  posted_at: z.iso.datetime({ offset: true }),
})

export type EntryPostedData = z.infer<typeof EntryPostedData>
