import { CheckpointView, errorOf, InclusionProofView, JournalView, LeafView } from '@carwash/contracts'
import { callApi, clientKey, unreachable } from '@/lib/server'
import type { JournalEvidence } from '@/lib/verify-journal'

export const dynamic = 'force-dynamic'

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

export async function GET(_request: Request, context: { params: Promise<{ seq: string }> }): Promise<Response> {
  const { seq } = await context.params
  if (!/^\d{1,15}$/.test(seq)) return refuse(400, 'invalid', 'seq must be a number')
  try {
    const signed = await callApi('GET', '/v1/audit/checkpoint', clientKey())
    if (signed.status !== 200) return refuse(409, 'no_checkpoint', 'the witness has not signed anything yet')
    const checkpoint = CheckpointView.parse(signed.body)
    if (Number(seq) >= checkpoint.tree_size)
      return refuse(409, 'not_witnessed', `the witness has signed ${checkpoint.tree_size} leaves, so pick a seq below that`)
    const found = await callApi('GET', `/v1/audit/leaves/${seq}`, clientKey())
    if (found.status !== 200) return refuse(404, 'no_leaf', `the log has no seq ${seq}`)
    const leaf = LeafView.parse(found.body)
    const [journal, proof] = await Promise.all([
      callApi('GET', `/v1/journals/${leaf.journal_id}`, clientKey()),
      callApi('GET', `/v1/journals/${leaf.journal_id}/proof?tree_size=${checkpoint.tree_size}`, clientKey()),
    ])
    if (proof.status !== 200) return refuse(409, 'no_proof', errorOf(proof.body)?.message ?? 'the API would not prove that leaf')
    return Response.json({
      journal: journal.status === 200 ? JournalView.parse(journal.body) : null,
      proof: InclusionProofView.parse(proof.body),
      checkpoint,
    } satisfies JournalEvidence)
  } catch {
    return unreachable()
  }
}
