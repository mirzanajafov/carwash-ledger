import { describe, expect, it } from 'vitest'
import { seqToCheck, type AuditState } from './audit'

function stateWith(tamperSeq: number | null, treeSize = 40): AuditState {
  const at = '2026-10-20T10:00:00.000Z'
  return {
    tamper: tamperSeq === null ? null : { tamper_class: 1, seq: tamperSeq, journal_id: '7', witnessed_size: treeSize, at, restores_at: null },
    tamperAvailable: true,
    checkpoint: { origin: 'carwash-ledger', tree_size: treeSize, root: '00', signature: 'sig', witness_key: 'key', signed_at: at },
    witnessKey: 'key',
  }
}

describe('the seq to check', () => {
  it('is the tampered journal while one is tampered with', () => {
    expect(seqToCheck(null, stateWith(12))).toBe('12')
  })

  it('is otherwise the newest journal the witness signed, and empty before the state arrives', () => {
    expect(seqToCheck(null, stateWith(null, 40))).toBe('39')
    expect(seqToCheck(null, { ...stateWith(null), checkpoint: null })).toBe('')
    expect(seqToCheck(null, null)).toBe('')
  })

  it('stays what the visitor typed, even an emptied field, whatever the next refresh brings', () => {
    expect(seqToCheck('5', stateWith(12))).toBe('5')
    expect(seqToCheck('', stateWith(null, 41))).toBe('')
  })
})
