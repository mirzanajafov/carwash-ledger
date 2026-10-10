import { describe, expect, it } from 'vitest'
import { ClientLedger, type Op } from '../src/client.ts'
import { compareWithClient, unsettled, type LedgerJournal } from '../src/compare.ts'

const capture = [
  { accountId: '1', amount: '1000' },
  { accountId: '2', amount: '-970' },
  { accountId: '3', amount: '-30' },
]
const reversal = capture.map((e) => ({ accountId: e.accountId, amount: (-BigInt(e.amount)).toString() }))

function acknowledged(client: ClientLedger, op: Op, journalId: string): void {
  client.dispatched(op)
  client.record(op.ref, { kind: 'posted', journalId }, 0)
}

function scenario() {
  const client = new ClientLedger(() => 0.5)
  const cap = client.add({ ref: 'cap:1', kind: 'capture', entries: capture })
  const rev = client.add({ ref: 'rev:cap:1', kind: 'reversal', entries: reversal, reversesRef: 'cap:1', reversesId: '10' })
  acknowledged(client, cap, '10')
  acknowledged(client, rev, '11')
  const journals: LedgerJournal[] = [
    { id: '10', externalRef: 'cap:1', reversesId: null, entries: [...capture].reverse() },
    { id: '11', externalRef: 'rev:cap:1', reversesId: '10', entries: reversal },
  ]
  return { client, cap, journals }
}

describe('compareWithClient', () => {
  it('accepts a ledger that holds exactly what the client was told, in any entry order', () => {
    const { client, journals } = scenario()
    expect(compareWithClient(client.ops.values(), journals)).toEqual({ count: 0, examples: [] })
  })

  it('finds an acknowledged journal that is missing', () => {
    const { client, journals } = scenario()
    const result = compareWithClient(client.ops.values(), journals.slice(1))
    expect(result.examples).toEqual(['cap:1 was acknowledged as journal 10 but is not in the ledger'])
  })

  it('finds a journal no client sent, changed entries and a wrong reversal link', () => {
    const { client, journals } = scenario()
    const tampered: LedgerJournal[] = [
      { ...journals[0]!, entries: [capture[0]!, { accountId: '2', amount: '-971' }, { accountId: '3', amount: '-29' }] },
      { ...journals[1]!, reversesId: '12' },
      { id: '12', externalRef: 'cap:99', reversesId: null, entries: capture },
    ]
    const result = compareWithClient(client.ops.values(), tampered)
    expect(result.count).toBe(3)
    expect(result.examples.join('\n')).toMatch(/cap:1 has entries .* the client sent/)
    expect(result.examples.join('\n')).toMatch(/rev:cap:1 reverses 12 in the ledger, the client asked for 10/)
    expect(result.examples.join('\n')).toMatch(/journal 12 \(cap:99\) was never sent by a client/)
  })

  it('does not blame the ledger for a journal whose outcome the client never learned', () => {
    const client = new ClientLedger(() => 0.5)
    client.add({ ref: 'cap:2', kind: 'capture', entries: capture })
    expect(compareWithClient(client.ops.values(), []).count).toBe(0)
    expect(unsettled(client.ops.values()).examples).toEqual(['cap:2 is still unresolved after 0 attempts (no answer)'])
  })
})
