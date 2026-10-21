import { describe, expect, it } from 'vitest'
import { EMPTY, reduce, type AuditPanelState, type AuditState } from './audit'

function server(treeSize: number | null, tamper: { seq: number; at: string } | null = null): AuditState {
  return {
    tamper: tamper && { tamper_class: 1, seq: tamper.seq, journal_id: '7', witnessed_size: treeSize ?? 0, at: tamper.at, restores_at: null },
    tamperAvailable: true,
    checkpoint:
      treeSize === null
        ? null
        : { origin: 'carwash-ledger', tree_size: treeSize, root: '00', signature: 'sig', witness_key: 'key', signed_at: '2026-10-20T10:00:00.000Z' },
    witnessKey: 'key',
    verification: null,
  }
}

function play(...steps: (AuditState | string)[]): AuditPanelState {
  return steps.reduce<AuditPanelState>(
    (panel, step) => reduce(panel, typeof step === 'string' ? { type: 'typed', seq: step } : { type: 'loaded', server: step }),
    EMPTY,
  )
}

describe('the seq on the audit page', () => {
  it('starts at the newest journal the witness signed', () => {
    expect(play(server(40)).seq).toBe('39')
  })

  it('waits for the first signed journal instead of offering seq -1', () => {
    expect(play(server(0)).seq).toBe('')
    expect(play(server(0), server(3)).seq).toBe('2')
  })

  it('stays where it is when later checkpoints land, even after the visitor emptied it', () => {
    expect(play(server(40), server(45)).seq).toBe('39')
    expect(play(server(40), '', server(45)).seq).toBe('')
  })

  it('stays empty when a poll without a checkpoint comes between two with one', () => {
    expect(play(server(40), '', server(null), server(45)).seq).toBe('')
  })

  it('keeps what the visitor typed before the first checkpoint, even an emptied field', () => {
    expect(play(server(null), '5', server(40)).seq).toBe('5')
    expect(play(server(null), '5', '', server(40)).seq).toBe('')
  })

  it('jumps to a new tamper, whoever made it, over what the visitor typed', () => {
    expect(play(server(40), '5', server(40, { seq: 12, at: 't1' })).seq).toBe('12')
  })

  it('keeps the tampered journal after the restore, so it can be checked again', () => {
    expect(play(server(40, { seq: 12, at: 't1' }), server(41)).seq).toBe('12')
  })

  it('keeps what the visitor typed while the same tamper is reported, even across a poll that missed it', () => {
    expect(play(server(40, { seq: 12, at: 't1' }), '30', server(41, { seq: 12, at: 't1' })).seq).toBe('30')
    expect(play(server(40, { seq: 12, at: 't1' }), '30', server(41), server(41, { seq: 12, at: 't1' })).seq).toBe('30')
  })

  it('jumps again for a second tamper of the same journal', () => {
    expect(play(server(40, { seq: 12, at: 't1' }), server(40), '30', server(40, { seq: 12, at: 't2' })).seq).toBe('12')
  })
})
