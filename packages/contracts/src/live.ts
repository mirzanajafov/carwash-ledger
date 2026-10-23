import * as z from 'zod/mini'

export const LiveBalance = z.object({
  code: z.string(),
  type: z.string(),
  currency: z.string(),
  amount: z.string(),
})

export type LiveBalance = z.infer<typeof LiveBalance>

export const LiveJournal = z.object({
  id: z.string(),
  external_ref: z.string(),
  posted_at: z.string(),
  entries: z.array(z.object({ account: z.string(), amount: z.string() })),
})

export type LiveJournal = z.infer<typeof LiveJournal>

export const LivePayment = z.object({
  id: z.string(),
  merchant: z.string(),
  amount: z.string(),
  currency: z.string(),
  status: z.string(),
  captured_amount: z.string(),
  refunded_amount: z.string(),
  updated_at: z.string(),
})

export type LivePayment = z.infer<typeof LivePayment>

export type LiveEvent = { type: 'balances'; data: LiveBalance[] } | { type: 'journal'; data: LiveJournal } | { type: 'payment'; data: LivePayment }

const LiveBalances = z.array(LiveBalance)

export function liveEvent(type: string, data: unknown): LiveEvent | undefined {
  if (type === 'balances') return { type, data: LiveBalances.parse(data) }
  if (type === 'journal') return { type, data: LiveJournal.parse(data) }
  if (type === 'payment') return { type, data: LivePayment.parse(data) }
  return undefined
}
