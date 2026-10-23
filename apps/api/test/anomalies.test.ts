import { describe, expect, it } from 'vitest'
import type { AnomalyRow } from '../src/payments/anomalies.repository.ts'
import { acceptable } from '../src/payments/anomalies.service.ts'

const ATTEMPT_ID = '0192f0c4-0000-7000-8000-000000000001'

function bankAnswer(changes: Record<string, unknown> = {}) {
  return {
    object: 'operation',
    id: 'op_1',
    idempotency_key: ATTEMPT_ID,
    kind: 'capture',
    status: 'succeeded',
    reason: null,
    amount: 1499,
    currency: 'EUR',
    charge: { id: 'ch_1' },
    ...changes,
  }
}

function refusedCapture(answer: { amount?: unknown }): AnomalyRow {
  return {
    id: '1',
    kind: 'answer_mismatch',
    created_at: new Date('2026-10-23T12:00:00Z'),
    details: { problems: ['amount is 1499, expected 1500'], answer },
    resolution: null,
    resolved_at: null,
    resolver: null,
    attempt: { id: ATTEMPT_ID, kind: 'capture', status: 'pending', amount: '1500', currency: 'EUR' },
    charge_id: 'ch_1',
    payment_id: null,
    refund_id: null,
    payout_id: null,
    merchant: 'wash_1',
  }
}

describe('an anomaly an admin can accept', () => {
  it('is a bank answer that differs only in an amount above zero and below what was asked', () => {
    expect(acceptable(refusedCapture(bankAnswer()))).toBe(true)
    expect(acceptable(refusedCapture(bankAnswer({ amount: 1 })))).toBe(true)
  })

  it('is not one whose amount accepting would refuse', () => {
    expect(acceptable(refusedCapture(bankAnswer({ amount: 0 })))).toBe(false)
    expect(acceptable(refusedCapture(bankAnswer({ amount: -1 })))).toBe(false)
    expect(acceptable(refusedCapture(bankAnswer({ amount: 1501 })))).toBe(false)
    expect(acceptable(refusedCapture(bankAnswer({ amount: undefined })))).toBe(false)
  })

  it('is not one where the bank differs in more than the amount, or declined', () => {
    expect(acceptable(refusedCapture(bankAnswer({ amount: 1500, currency: 'USD' })))).toBe(false)
    expect(acceptable(refusedCapture(bankAnswer({ currency: 'USD' })))).toBe(false)
    expect(acceptable(refusedCapture(bankAnswer({ charge: { id: 'ch_2' } })))).toBe(false)
    expect(acceptable(refusedCapture(bankAnswer({ status: 'declined' })))).toBe(false)
  })

  it('is only a mismatch still open on a pending capture, refund or payout', () => {
    const capture = refusedCapture(bankAnswer())
    expect(acceptable({ ...capture, kind: 'answer_changed' })).toBe(false)
    expect(acceptable({ ...capture, resolved_at: new Date() })).toBe(false)
    expect(acceptable({ ...capture, attempt: capture.attempt && { ...capture.attempt, kind: 'authorize' } })).toBe(false)
    expect(acceptable({ ...capture, attempt: capture.attempt && { ...capture.attempt, status: 'succeeded' } })).toBe(false)
  })
})
