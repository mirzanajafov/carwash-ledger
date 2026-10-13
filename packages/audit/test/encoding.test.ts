import { describe, expect, it } from 'vitest'
import { canonicalJournal, leafHash, toHex } from '../src/index.ts'

const journal = {
  id: 42n,
  externalRef: 'capture:01a1',
  createdAtMicros: 1_791_871_992_123_456n,
  entries: [
    { id: 102n, accountId: 7n, amount: -1460n },
    { id: 101n, accountId: 3n, amount: 1500n },
    { id: 103n, accountId: 5n, amount: -40n },
  ],
}

describe('canonicalJournal', () => {
  it('writes a version byte, fixed-width integers, a length-prefixed reference and entries sorted by id', () => {
    expect(toHex(canonicalJournal(journal))).toBe(
      '01' +
        '000000000000002a' +
        '0000000c' + '636170747572653a30316131' +
        '00065db2b592d040' +
        '00000003' +
        '0000000000000065' + '0000000000000003' + '00000000000005dc' +
        '0000000000000066' + '0000000000000007' + 'fffffffffffffa4c' +
        '0000000000000067' + '0000000000000005' + 'ffffffffffffffd8',
    )
  })

  it('does not depend on the order the entries came in, and changes when any field does', () => {
    const shuffled = { ...journal, entries: [...journal.entries].reverse() }
    expect(toHex(leafHash(canonicalJournal(shuffled)))).toBe(toHex(leafHash(canonicalJournal(journal))))
    const variants = [
      { ...journal, id: 43n },
      { ...journal, externalRef: 'capture:01a2' },
      { ...journal, createdAtMicros: journal.createdAtMicros + 1n },
      { ...journal, entries: journal.entries.map((e, i) => (i === 0 ? { ...e, amount: e.amount - 1n } : e)) },
      { ...journal, entries: journal.entries.map((e, i) => (i === 1 ? { ...e, accountId: 8n } : e)) },
    ]
    const hashes = new Set(variants.map((v) => toHex(leafHash(canonicalJournal(v)))))
    hashes.add(toHex(leafHash(canonicalJournal(journal))))
    expect(hashes.size).toBe(variants.length + 1)
  })

  it('refuses values that do not fit and an entry listed twice', () => {
    expect(() => canonicalJournal({ ...journal, id: -1n })).toThrow(RangeError)
    expect(() => canonicalJournal({ ...journal, entries: [...journal.entries, journal.entries[0]!] })).toThrow('appears twice')
  })
})
