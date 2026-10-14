import { generateKeyPairSync, sign } from 'node:crypto'
import { checkpointBody, completedBy, fromHex, inclusionProof, rootOf, toHex, type Hash } from '@carwash/audit'
import { describe, expect, it } from 'vitest'
import { checkJournal, leafOf, type CheckpointJson, type JournalJson } from './verify-journal'

function journalAt(n: number, amount = 2400): JournalJson {
  return {
    id: String(100 + n),
    external_ref: `capture:${n}`,
    created_at_micros: String(1_791_900_000_000_000 + n),
    seq: n,
    entries: [
      { id: String(1000 + 3 * n), account_id: '1', account: 'psp_receivable:EUR', amount: String(amount) },
      { id: String(1001 + 3 * n), account_id: '7', account: 'merchant_payable:wash_north', amount: String(-(amount - 58)) },
      { id: String(1002 + 3 * n), account_id: '2', account: 'platform_fee_revenue:EUR', amount: '-58' },
    ],
  }
}

function tree(journals: JournalJson[]) {
  const nodes = new Map<string, Hash>()
  const source = (level: number, index: number) => nodes.get(`${level}:${index}`)!
  journals.forEach((journal, index) => {
    for (const node of completedBy(index, fromHex(leafOf(journal)), source)) nodes.set(`${node.level}:${node.index}`, node.hash)
  })
  return {
    root: (size: number) => toHex(rootOf(size, source)),
    proof: (seq: number, size: number) => ({
      journal_id: journals[seq]!.id,
      seq,
      leaf: leafOf(journals[seq]!),
      tree_size: size,
      root: toHex(rootOf(size, source)),
      proof: inclusionProof(seq, size, source).map(toHex),
    }),
  }
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const witnessKey = publicKey.export({ format: 'jwk' }).x!

function signedCheckpoint(size: number, root: string): CheckpointJson {
  const signature = sign(null, Buffer.from(checkpointBody({ size, root }, 'carwash-ledger')), privateKey).toString('base64')
  return { origin: 'carwash-ledger', tree_size: size, root, signature, witness_key: witnessKey }
}

const journals = Array.from({ length: 13 }, (_, n) => journalAt(n))
const honest = tree(journals)
const checkpoint = signedCheckpoint(13, honest.root(13))

const verdicts = async (journal: JournalJson | null, proof = honest.proof(5, 13), signed = checkpoint) =>
  Object.fromEntries((await checkJournal({ journal, proof, checkpoint: signed, witnessKey })).map((v) => [v.name, v.ok]))

describe('checking one journal in the browser', () => {
  it('accepts an honest journal on all four counts', async () => {
    expect(await verdicts(journals[5]!)).toEqual({ signature: true, key: true, rows: true, inclusion: true })
  })

  it('sees changed amounts with untouched hashes (class 1) in the rows and in the tree', async () => {
    expect(await verdicts(journalAt(5, 2500))).toEqual({ signature: true, key: true, rows: false, inclusion: false })
  })

  it('sees rewritten hashes that agree with the rows (class 2) only against the signed root', async () => {
    const forged = [...journals]
    forged[5] = journalAt(5, 2500)
    expect(await verdicts(forged[5]!, tree(forged).proof(5, 13))).toEqual({ signature: true, key: true, rows: true, inclusion: false })
  })

  it('reports a deleted journal (class 3) whose leaf is still in the signed tree', async () => {
    expect(await verdicts(null)).toEqual({ signature: true, key: true, rows: false, inclusion: true })
  })

  it('refuses a checkpoint the witness did not sign and a key the witness does not publish', async () => {
    expect((await verdicts(journals[5]!, honest.proof(5, 13), { ...checkpoint, root: honest.root(12) })).signature).toBe(false)
    expect((await verdicts(journals[5]!, honest.proof(5, 13), { ...checkpoint, witness_key: 'A'.repeat(43) })).key).toBe(false)
  })
})
