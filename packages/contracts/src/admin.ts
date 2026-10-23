import * as z from 'zod/mini'

export const HealthView = z.object({
  ok: z.literal(true),
  pid: z.number(),
  started_at: z.string(),
})

export type HealthView = z.infer<typeof HealthView>

export const PlugView = z.object({
  object: z.literal('plug'),
  failpoint: z.string(),
  pid: z.number(),
  started_at: z.string(),
  armed_at: z.string(),
})

export type PlugView = z.infer<typeof PlugView>

export const InvariantResult = z.object({
  id: z.string(),
  description: z.string(),
  count: z.number(),
  examples: z.array(z.string()),
})

export type InvariantResult = z.infer<typeof InvariantResult>

export const InvariantChecksView = z.object({
  object: z.literal('invariant_checks'),
  ran_at: z.string(),
  ms: z.number(),
  witnessed: z.boolean(),
  payment_checks: z.object({
    since: z.nullable(z.string()),
    payments: z.number(),
    merchant_entries: z.number(),
  }),
  results: z.array(InvariantResult),
})

export type InvariantChecksView = z.infer<typeof InvariantChecksView>

export const SessionView = z.object({
  object: z.literal('session'),
  id: z.string(),
  client: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
})

export type SessionView = z.infer<typeof SessionView>

export const OpenedSessionView = z.extend(SessionView, { token: z.string() })

export type OpenedSessionView = z.infer<typeof OpenedSessionView>

export const ClosedSessionView = z.extend(SessionView, { revoked: z.literal(true) })

export type ClosedSessionView = z.infer<typeof ClosedSessionView>

export const AnomalyView = z.object({
  object: z.literal('anomaly'),
  id: z.string(),
  kind: z.enum(['answer_mismatch', 'unexpected_answer', 'answer_changed', 'refund_declined', 'unmatched_webhook']),
  created_at: z.string(),
  problems: z.array(z.string()),
  attempt: z.nullable(
    z.object({
      id: z.string(),
      kind: z.enum(['authorize', 'capture', 'cancel', 'refund', 'payout']),
      status: z.enum(['pending', 'succeeded', 'declined']),
      amount: z.string(),
      currency: z.string(),
    }),
  ),
  bank_amount: z.nullable(z.string()),
  payment_id: z.nullable(z.string()),
  refund_id: z.nullable(z.string()),
  payout_id: z.nullable(z.string()),
  merchant: z.nullable(z.string()),
  acceptable: z.boolean(),
  resolution: z.nullable(z.string()),
  resolved_at: z.nullable(z.string()),
  resolved_by: z.nullable(z.string()),
})

export type AnomalyView = z.infer<typeof AnomalyView>

export const AnomalyList = z.object({
  object: z.literal('list'),
  data: z.array(AnomalyView),
})

export type AnomalyList = z.infer<typeof AnomalyList>
