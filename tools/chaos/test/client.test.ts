import { describe, expect, it } from 'vitest'
import { ClientLedger } from '../src/client.ts'

const entries = [
  { accountId: '1', amount: '100' },
  { accountId: '2', amount: '-100' },
]

function ledger() {
  return new ClientLedger(() => 0.5)
}

describe('ClientLedger', () => {
  it('retries an unknown outcome after a backoff and acknowledges the first answer that names a journal', () => {
    const client = ledger()
    const op = client.add({ ref: 'cap:1', kind: 'capture', entries, retryAt: 0 })
    expect(client.due(0)).toEqual([op])

    client.dispatched(op)
    expect(client.due(0)).toEqual([])
    expect(client.record('cap:1', { kind: 'retryable', error: 'worker died' }, 10)).toBe('retry')
    expect(client.due(10)).toEqual([])
    expect(client.due(10 + client.backoff(1))).toEqual([op])

    client.dispatched(op)
    expect(client.record('cap:1', { kind: 'duplicate', journalId: '42' }, 300)).toBe('acknowledged')
    expect(op).toMatchObject({ acknowledged: true, journalId: '42', attempts: 2, inFlight: 0 })
    expect(client.unresolved()).toEqual([])
  })

  it('waits for every copy of a request sent twice before it retries', () => {
    const client = ledger()
    const op = client.add({ ref: 'cap:2', kind: 'capture', entries, retryAt: 0 })
    client.dispatched(op)
    client.dispatched(op)
    expect(client.record('cap:2', { kind: 'retryable', error: 'timeout' }, 5)).toBe('ignored')
    expect(client.record('cap:2', { kind: 'posted', journalId: '7' }, 6)).toBe('acknowledged')
    expect(client.due(10_000)).toEqual([])
  })

  it('records a second journal id for the same ref as a conflict', () => {
    const client = ledger()
    const op = client.add({ ref: 'cap:3', kind: 'capture', entries, retryAt: 0 })
    client.dispatched(op)
    client.dispatched(op)
    client.record('cap:3', { kind: 'posted', journalId: '8' }, 1)
    expect(client.record('cap:3', { kind: 'posted', journalId: '9' }, 2)).toBe('ignored')
    expect(op.journalId).toBe('8')
    expect(op.conflicts).toEqual(['cap:3 was acknowledged as journal 8 and then as 9'])
  })

  it('keeps a rejection final and never retries it', () => {
    const client = ledger()
    const op = client.add({ ref: 'cap:4', kind: 'capture', entries, retryAt: 0 })
    client.dispatched(op)
    expect(client.record('cap:4', { kind: 'rejected', error: 'LG002' }, 1)).toBe('rejected')
    expect(client.due(10_000)).toEqual([])
    expect(client.unresolved()).toEqual([])
  })

  it('caps the backoff at two seconds', () => {
    const client = new ClientLedger(() => 0.999)
    expect(client.backoff(1)).toBe(100)
    expect(client.backoff(30)).toBeLessThanOrEqual(2000)
  })
})
