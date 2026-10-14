import { canonicalJournal, checkpointBody, fromHex, leafHash, toHex, verifyInclusion } from '@carwash/audit'

export interface JournalJson {
  id: string
  external_ref: string
  created_at_micros: string
  seq: number | null
  entries: { id: string; account_id: string; account: string; amount: string }[]
}

export interface ProofJson {
  journal_id: string
  seq: number
  leaf: string
  tree_size: number
  root: string
  proof: string[]
}

export interface CheckpointJson {
  origin: string
  tree_size: number
  root: string
  signature: string
  witness_key: string
}

export interface Verdict {
  name: 'signature' | 'key' | 'rows' | 'inclusion'
  ok: boolean | null
  detail: string
}

function base64(text: string): Uint8Array<ArrayBuffer> {
  const normal = text.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normal + '='.repeat((4 - (normal.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

async function signed(checkpoint: CheckpointJson, publicKey: string): Promise<boolean | null> {
  try {
    const key = await crypto.subtle.importKey('raw', base64(publicKey), { name: 'Ed25519' }, false, ['verify'])
    const body = new TextEncoder().encode(checkpointBody({ size: checkpoint.tree_size, root: checkpoint.root }, checkpoint.origin))
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, base64(checkpoint.signature), body)
  } catch (error) {
    if ((error as Error).name === 'NotSupportedError') return null
    return false
  }
}

export function leafOf(journal: JournalJson): string {
  return toHex(
    leafHash(
      canonicalJournal({
        id: BigInt(journal.id),
        externalRef: journal.external_ref,
        createdAtMicros: BigInt(journal.created_at_micros),
        entries: journal.entries.map((e) => ({ id: BigInt(e.id), accountId: BigInt(e.account_id), amount: BigInt(e.amount) })),
      }),
    ),
  )
}

export async function checkJournal(input: { journal: JournalJson | null; proof: ProofJson; checkpoint: CheckpointJson; witnessKey: string }): Promise<Verdict[]> {
  const { journal, proof, checkpoint, witnessKey } = input
  const verdicts: Verdict[] = []
  const signature = await signed(checkpoint, witnessKey)
  verdicts.push({
    name: 'signature',
    ok: signature,
    detail:
      signature === null
        ? 'This browser cannot check Ed25519 signatures yet.'
        : signature
          ? `The witness signed tree size ${checkpoint.tree_size} with root ${checkpoint.root.slice(0, 16)}…`
          : `The signature on tree size ${checkpoint.tree_size} does not verify with the witness's key.`,
  })
  verdicts.push({
    name: 'key',
    ok: checkpoint.witness_key === witnessKey,
    detail: checkpoint.witness_key === witnessKey ? 'The ledger kept the same key the witness publishes.' : 'The ledger kept a different key from the one the witness publishes.',
  })
  const computed = journal ? leafOf(journal) : null
  verdicts.push({
    name: 'rows',
    ok: computed === proof.leaf,
    detail: !journal
      ? `The log has a leaf for journal ${proof.journal_id} at seq ${proof.seq}, but the journal is gone.`
      : computed === proof.leaf
        ? `The journal's rows hash to the leaf the log holds at seq ${proof.seq}.`
        : `The journal's rows hash to ${computed!.slice(0, 16)}…, the log holds ${proof.leaf.slice(0, 16)}…`,
  })
  const included = verifyInclusion(fromHex(computed ?? proof.leaf), proof.seq, checkpoint.tree_size, proof.proof.map(fromHex), fromHex(checkpoint.root))
  verdicts.push({
    name: 'inclusion',
    ok: included,
    detail: included
      ? `With ${proof.proof.length} hashes from the server, that leaf leads to the root the witness signed.`
      : `The ${proof.proof.length} hashes from the server don't lead from that leaf to the root the witness signed.`,
  })
  return verdicts
}
