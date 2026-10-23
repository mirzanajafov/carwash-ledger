import { describe, expect, it } from 'vitest'
import type { AnomalyRow } from '../src/payments/anomalies.repository.ts'
import { acceptable } from '../src/payments/anomalies.service.ts'

function refusedCapture(bankAmount: unknown): AnomalyRow {
  return {
    id: '1',
    kind: 'answer_mismatch',
    created_at: new Date('2026-10-23T12:00:00Z'),
    details: { problems: ['amount differs'], answer: { amount: bankAmount } },
    resolution: null,
    resolved_at: null,
    resolver: null,
    attempt: { id: '0192f0c4-0000-7000-8000-000000000001', kind: 'capture', status: 'pending', amount: '1500', currency: 'EUR' },
    payment_id: null,
    refund_id: null,
    payout_id: null,
    merchant: 'wash_1',
  }
}

describe('an anomaly an admin can accept', () => {
  it('is a refused amount the bank says it took, above zero and no more than was asked, like accepting checks', () => {
    expect(acceptable(refusedCapture(1499))).toBe(true)
    expect(acceptable(refusedCapture(1500))).toBe(true)
    expect(acceptable(refusedCapture(0))).toBe(false)
    expect(acceptable(refusedCapture(-1))).toBe(false)
    expect(acceptable(refusedCapture(1501))).toBe(false)
    expect(acceptable(refusedCapture(undefined))).toBe(false)
  })

  it('is only a mismatch still open on a pending capture, refund or payout', () => {
    expect(acceptable({ ...refusedCapture(1499), kind: 'answer_changed' })).toBe(false)
    expect(acceptable({ ...refusedCapture(1499), resolved_at: new Date() })).toBe(false)
    const capture = refusedCapture(1499)
    expect(acceptable({ ...capture, attempt: capture.attempt && { ...capture.attempt, kind: 'authorize' } })).toBe(false)
  })
})
