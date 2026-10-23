import * as z from 'zod/mini'

export const PaymentView = z.object({
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
  failure_reason: z.nullable(z.string()),
  created: z.number(),
})

export type PaymentView = z.infer<typeof PaymentView>

export const RefundView = z.object({
  id: z.string(),
  object: z.literal('refund'),
  payment: z.string(),
  amount: z.number(),
  status: z.enum(['pending', 'succeeded', 'failed']),
  fee_refund: z.number(),
  failure_reason: z.nullable(z.string()),
  created: z.number(),
})

export type RefundView = z.infer<typeof RefundView>

export const PayoutView = z.object({
  id: z.string(),
  object: z.literal('payout'),
  merchant: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: z.enum(['pending', 'succeeded', 'failed']),
  failure_reason: z.nullable(z.string()),
  created: z.number(),
})

export type PayoutView = z.infer<typeof PayoutView>

export const MerchantView = z.object({
  id: z.string(),
  object: z.literal('merchant'),
  name: z.string(),
  currency: z.string(),
  account: z.string(),
  payable: z.number(),
})

export type MerchantView = z.infer<typeof MerchantView>

export const BalanceView = z.object({
  object: z.literal('balance'),
  account: z.string(),
  currency: z.string(),
  balance_mode: z.string(),
  balance: z.number(),
})

export type BalanceView = z.infer<typeof BalanceView>
