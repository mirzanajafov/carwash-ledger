import * as z from 'zod/mini'

export const TamperView = z.object({
  tamper_class: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  seq: z.number(),
  journal_id: z.string(),
  witnessed_size: z.number(),
  at: z.string(),
  restores_at: z.nullable(z.string()),
})

export type TamperView = z.infer<typeof TamperView>

export const TamperState = z.object({ tamper: z.nullable(TamperView) })

export type TamperState = z.infer<typeof TamperState>

export const RestoredView = z.object({ restored: TamperView })

export type RestoredView = z.infer<typeof RestoredView>
