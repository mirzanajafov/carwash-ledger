import { callApi, clientKey, unreachable } from '@/lib/server'

export const dynamic = 'force-dynamic'

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

export async function GET(_request: Request, context: { params: Promise<{ seq: string }> }): Promise<Response> {
  const { seq } = await context.params
  if (!/^\d{1,15}$/.test(seq)) return refuse(400, 'invalid', 'seq must be a number')
  try {
    const checkpoint = await callApi('GET', '/v1/audit/checkpoint', clientKey())
    if (checkpoint.status !== 200) return refuse(409, 'no_checkpoint', 'the witness has not signed anything yet')
    if (Number(seq) >= checkpoint.body.tree_size)
      return refuse(409, 'not_witnessed', `the witness has signed ${checkpoint.body.tree_size} leaves, so pick a seq below that`)
    const leaf = await callApi('GET', `/v1/audit/leaves/${seq}`, clientKey())
    if (leaf.status !== 200) return refuse(404, 'no_leaf', `the log has no seq ${seq}`)
    const [journal, proof] = await Promise.all([
      callApi('GET', `/v1/journals/${leaf.body.journal_id}`, clientKey()),
      callApi('GET', `/v1/journals/${leaf.body.journal_id}/proof?tree_size=${checkpoint.body.tree_size}`, clientKey()),
    ])
    if (proof.status !== 200) return refuse(409, 'no_proof', proof.body?.error?.message ?? 'the API would not prove that leaf')
    return Response.json({ journal: journal.status === 200 ? journal.body : null, proof: proof.body, checkpoint: checkpoint.body })
  } catch {
    return unreachable()
  }
}
