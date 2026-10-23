import { describe, expect, it } from 'vitest'
import type { AnomalyRow } from '../src/payments/anomalies.repository.ts'
import { acceptable } from '../src/payments/anomalies.service.ts'
import type { AttemptKind } from '../src/psp/answers.ts'

const ATTEMPT_ID = '0192f0c4-0000-7000-8000-000000000001'

function bankAnswer(kind: AttemptKind, changes: Record<string, unknown> = {}) {
  return {
    object: 'operation',
    id: 'op_1',
    idempotency_key: ATTEMPT_ID,
    kind,
    status: 'succeeded',
    reason: null,
    amount: 1499,
    currency: 'EUR',
    charge: kind === 'payout' ? null : { id: 'ch_1' },
    ...changes,
  }
}

function refused(kind: AttemptKind, changes: Record<string, unknown> = {}): AnomalyRow {
  return {
    id: '1',
    kind: 'answer_mismatch',
    created_at: new Date('2026-10-23T12:00:00Z'),
    details: { problems: ['amount is 1499, expected 1500'], answer: bankAnswer(kind, changes) },
    resolution: null,
    resolved_at: null,
    resolver: null,
    attempt: { id: ATTEMPT_ID, kind, status: 'pending', amount: '1500', currency: 'EUR' },
    charge_id: kind === 'payout' ? null : 'ch_1',
    payment_id: null,
    refund_id: null,
    payout_id: null,
    merchant: 'wash_1',
  }
}

describe('an anomaly an admin can accept', () => {
  it('is a bank answer above zero and no more than was asked, matching in everything else', () => {
    for (const kind of ['capture', 'refund', 'payout'] as const) {
      expect(acceptable(refused(kind))).toBe(true)
      expect(acceptable(refused(kind, { amount: 1 }))).toBe(true)
      expect(acceptable(refused(kind, { amount: 1500 }))).toBe(true)
    }
  })

  it('is not one whose amount accepting would refuse', () => {
    for (const kind of ['capture', 'refund', 'payout'] as const) {
      expect(acceptable(refused(kind, { amount: 0 }))).toBe(false)
      expect(acceptable(refused(kind, { amount: -1 }))).toBe(false)
      expect(acceptable(refused(kind, { amount: 1501 }))).toBe(false)
      expect(acceptable(refused(kind, { amount: undefined }))).toBe(false)
    }
  })

  it('is not one where the bank differs in more than the amount, or declined', () => {
    expect(acceptable(refused('capture', { amount: 1500, currency: 'USD' }))).toBe(false)
    expect(acceptable(refused('capture', { currency: 'USD' }))).toBe(false)
    expect(acceptable(refused('refund', { charge: { id: 'ch_2' } }))).toBe(false)
    expect(acceptable(refused('payout', { kind: 'refund' }))).toBe(false)
    expect(acceptable(refused('capture', { status: 'declined' }))).toBe(false)
  })

  it('is only a mismatch still open on a pending capture, refund or payout', () => {
    const capture = refused('capture')
    expect(acceptable({ ...capture, kind: 'answer_changed' })).toBe(false)
    expect(acceptable({ ...capture, resolved_at: new Date() })).toBe(false)
    expect(acceptable(refused('authorize', { charge: { id: 'ch_1', authorized_amount: 1499 } }))).toBe(false)
    expect(acceptable({ ...capture, attempt: capture.attempt && { ...capture.attempt, status: 'succeeded' } })).toBe(false)
  })
})
