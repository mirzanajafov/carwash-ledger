import { describe, expect, it } from 'vitest'
import { resolveCardAttempt } from '../src/payments/payment-state.ts'

describe('a card attempt the bank answered', () => {
  it('turns a PSP answer into a move, or into an anomaly when it does not fit', () => {
    expect(resolveCardAttempt('created', 'authorize', 'succeeded', null)).toEqual({ kind: 'move', from: 'created', to: 'authorized' })
    expect(resolveCardAttempt('created', 'authorize', 'declined', 'card_declined')).toEqual({ kind: 'move', from: 'created', to: 'failed' })
    expect(resolveCardAttempt('authorized', 'capture', 'declined', 'authorization_expired')).toEqual({
      kind: 'move',
      from: 'authorized',
      to: 'failed',
    })
    expect(resolveCardAttempt('authorized', 'capture', 'declined', 'charge_already_captured').kind).toBe('anomaly')
    expect(resolveCardAttempt('captured', 'capture', 'succeeded', null).kind).toBe('anomaly')
    expect(resolveCardAttempt('authorized', 'cancel', 'succeeded', null)).toEqual({ kind: 'move', from: 'authorized', to: 'canceled' })
  })
})
