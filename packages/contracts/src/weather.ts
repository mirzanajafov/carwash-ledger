import * as z from 'zod/mini'

const Share = z.optional(z.number())

export const FaultPlanView = z.object({
  seed: z.optional(z.number()),
  decline: Share,
  fail: Share,
  timeoutAfterCommit: Share,
  slow: Share,
  slowMs: z.optional(z.readonly(z.tuple([z.number(), z.number()]))),
  wrongAmount: Share,
  webhook: z.optional(z.partialRecord(z.enum(['duplicate', 'delay', 'reorder', 'drop']), z.number())),
  settlement: z.optional(z.partialRecord(z.enum(['nextDay', 'feeDifference', 'wrongAmount', 'missingLine', 'duplicateLine', 'droppedReference']), z.number())),
})

export type FaultPlanView = z.infer<typeof FaultPlanView>

export const WeatherView = z.object({
  base: FaultPlanView,
  weather: z.nullable(z.object({ label: z.string(), plan: FaultPlanView, until: z.string() })),
})

export type WeatherView = z.infer<typeof WeatherView>
