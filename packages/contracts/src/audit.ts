import * as z from 'zod/mini'

export const AuditHeadView = z.object({
  object: z.literal('audit_head'),
  tree_size: z.number(),
  root: z.string(),
  chain: z.string(),
})

export type AuditHeadView = z.infer<typeof AuditHeadView>

export const CheckpointView = z.object({
  object: z.literal('audit_checkpoint'),
  origin: z.string(),
  tree_size: z.number(),
  root: z.string(),
  signature: z.string(),
  witness_key: z.string(),
  signed_at: z.string(),
})

export type CheckpointView = z.infer<typeof CheckpointView>

export const CheckpointList = z.object({
  object: z.literal('list'),
  data: z.array(z.object({ tree_size: z.number(), root: z.string(), signed_at: z.string() })),
})

export type CheckpointList = z.infer<typeof CheckpointList>

export const LeafView = z.object({
  object: z.literal('leaf'),
  seq: z.number(),
  journal_id: z.string(),
  leaf: z.string(),
})

export type LeafView = z.infer<typeof LeafView>

export const JournalView = z.object({
  object: z.literal('journal'),
  id: z.string(),
  external_ref: z.string(),
  created_at: z.string(),
  created_at_micros: z.string(),
  seq: z.nullable(z.number()),
  entries: z.array(z.object({ id: z.string(), account_id: z.string(), account: z.string(), amount: z.string() })),
})

export type JournalView = z.infer<typeof JournalView>

export const InclusionProofView = z.object({
  object: z.literal('inclusion_proof'),
  journal_id: z.string(),
  seq: z.number(),
  leaf: z.string(),
  tree_size: z.number(),
  root: z.string(),
  proof: z.array(z.string()),
})

export type InclusionProofView = z.infer<typeof InclusionProofView>

export const ConsistencyProofView = z.object({
  object: z.literal('consistency_proof'),
  first: z.number(),
  second: z.number(),
  first_root: z.string(),
  second_root: z.string(),
  proof: z.array(z.string()),
})

export type ConsistencyProofView = z.infer<typeof ConsistencyProofView>

export const VerificationFinding = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing_journal'), seq: z.number(), journalId: z.string() }),
  z.object({ kind: z.literal('leaf'), seq: z.number(), journalId: z.string() }),
  z.object({ kind: z.literal('chain'), seq: z.number() }),
  z.object({ kind: z.literal('gap'), seq: z.number(), missing: z.number() }),
  z.object({ kind: z.literal('root'), size: z.number(), after: z.number() }),
  z.object({ kind: z.literal('signature'), size: z.number() }),
  z.object({ kind: z.literal('beyond'), size: z.number(), treeSize: z.number() }),
  z.object({ kind: z.literal('history'), size: z.number(), what: z.enum(['chain', 'root']) }),
  z.object({ kind: z.literal('unsequenced'), journalId: z.string() }),
])

export type VerificationFinding = z.infer<typeof VerificationFinding>

export const VerificationReport = z.object({
  mode: z.enum(['full', 'incremental']),
  from: z.number(),
  size: z.number(),
  journals: z.number(),
  witnessed: z.number(),
  findings: z.number(),
  examples: z.array(VerificationFinding),
  firstSeq: z.nullable(z.number()),
  ms: z.object({ read: z.number(), compute: z.number(), yielded: z.optional(z.number()), total: z.number() }),
  root: z.nullable(z.string()),
})

export type VerificationReport = z.infer<typeof VerificationReport>

export const VerificationRunView = z.object({
  object: z.literal('verification_run'),
  id: z.string(),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  requested_at: z.string(),
  started_at: z.nullable(z.string()),
  finished_at: z.nullable(z.string()),
  attempts: z.number(),
  progress: z.nullable(z.object({ checked: z.number(), size: z.number() })),
  report: z.nullable(VerificationReport),
  error: z.nullable(z.string()),
})

export type VerificationRunView = z.infer<typeof VerificationRunView>
