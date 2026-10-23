import * as z from 'zod/mini'

export const BreakClass = z.enum(['missing_line', 'duplicate_line', 'wrong_amount', 'fee_difference', 'unknown_line'])

export type BreakClass = z.infer<typeof BreakClass>

export const BreakView = z.object({
  day: z.number(),
  class: BreakClass,
  file_id: z.nullable(z.string()),
  line: z.nullable(z.number()),
  journal_ref: z.nullable(z.string()),
  attempt_id: z.nullable(z.string()),
  detail: z.string(),
})

export type BreakView = z.infer<typeof BreakView>

export const BreakList = z.object({
  object: z.literal('list'),
  data: z.array(BreakView),
})

export type BreakList = z.infer<typeof BreakList>

const SettlementFile = z.object({
  id: z.string(),
  lines: z.number(),
  gross: z.string(),
  fee: z.string(),
  net: z.string(),
  journal_id: z.nullable(z.string()),
  received_at: z.string(),
})

export const SettlementDaySummary = z.extend(SettlementFile, {
  day: z.number(),
  breaks: z.partialRecord(BreakClass, z.number()),
})

export type SettlementDaySummary = z.infer<typeof SettlementDaySummary>

export const SettlementDayList = z.object({
  object: z.literal('list'),
  day_seconds: z.nullable(z.number()),
  current_day: z.nullable(z.number()),
  data: z.array(SettlementDaySummary),
})

export type SettlementDayList = z.infer<typeof SettlementDayList>

export const SettlementLineView = z.object({
  line: z.number(),
  operation: z.string(),
  reference: z.string(),
  kind: z.string(),
  gross: z.string(),
  fee: z.string(),
  net: z.string(),
  operated_at: z.string(),
  break: z.nullable(BreakClass),
})

export type SettlementLineView = z.infer<typeof SettlementLineView>

export const SettlementDayView = z.object({
  object: z.literal('settlement_day'),
  day: z.number(),
  currency: z.string(),
  file: z.nullable(SettlementFile),
  lines: z.array(SettlementLineView),
  breaks: z.array(BreakView),
})

export type SettlementDayView = z.infer<typeof SettlementDayView>

export const SettlementView = z.object({
  object: z.literal('settlement'),
  day: z.number(),
  currency: z.string(),
  outcome: z.enum(['ingested', 'already', 'not_ready']),
  reconciliation: z.optional(
    z.object({
      currency: z.string(),
      from: z.number(),
      through: z.number(),
      lines: z.number(),
      items: z.number(),
      matched: z.number(),
      late: z.number(),
      pending: z.number(),
      breaks: z.record(BreakClass, z.number()),
    }),
  ),
})

export type SettlementView = z.infer<typeof SettlementView>
