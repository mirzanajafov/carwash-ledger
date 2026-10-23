import * as z from 'zod/mini'

export const WitnessKeyView = z.object({ origin: z.string(), algorithm: z.string(), public_key: z.string() })

export type WitnessKeyView = z.infer<typeof WitnessKeyView>

export const WitnessCheckpointView = z.object({ size: z.number(), root: z.string(), signature: z.string(), signed_at: z.string() })

export type WitnessCheckpointView = z.infer<typeof WitnessCheckpointView>
