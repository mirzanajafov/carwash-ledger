import * as z from 'zod/mini'

export const WebhookReceipt = z.object({
  received: z.literal(true),
  outcome: z.enum(['applied', 'already', 'anomaly', 'not_at_psp', 'unmatched', 'reported']),
  duplicate: z.optional(z.literal(true)),
})

export type WebhookReceipt = z.infer<typeof WebhookReceipt>
