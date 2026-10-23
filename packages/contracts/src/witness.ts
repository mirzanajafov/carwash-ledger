import * as z from 'zod/mini'

const PROOF = 'proof must be a list of hex hashes'

function integerFrom(min: number, error: string) {
  return z.int({ error }).check(z.gte(min, { error }))
}

function hash(error: string) {
  return z.string({ error }).check(z.regex(/^[0-9a-f]{64}$/, { error }))
}

export const WitnessKeyView = z.object({ origin: z.string(), algorithm: z.string(), public_key: z.string() })

export type WitnessKeyView = z.infer<typeof WitnessKeyView>

export const SignedCheckpointView = z.object({ size: z.number(), root: z.string(), signature: z.string(), signed_at: z.string() })

export type SignedCheckpointView = z.infer<typeof SignedCheckpointView>

export const CheckpointSubmission = z.object(
  {
    size: integerFrom(1, 'size must be a positive integer'),
    from_size: z._default(integerFrom(0, 'from_size must be a non-negative integer'), 0),
    root: hash('root must be 32 bytes of hex'),
    proof: z._default(z.array(hash(PROOF), { error: PROOF }).check(z.maxLength(64, { error: PROOF })), []),
  },
  { error: 'the body must be a JSON object' },
)

export type CheckpointSubmission = z.infer<typeof CheckpointSubmission>
