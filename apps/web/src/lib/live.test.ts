import { describe, expect, it } from 'vitest'
import { EMPTY, reduce, totals, type Journal, type Payment } from './live'
import { money } from './money'

const journal = (id: string, entries: [string, string][]): Journal => ({
  id,
  external_ref: `capture:${id}`,
  posted_at: '2026-10-14T10:00:00.000Z',
  entries: entries.map(([account, amount]) => ({ account, amount })),
})

const payment = (id: string, status: string): Payment => ({
  id,
  merchant: 'wash_north',
  amount: '2400',
  currency: 'EUR',
  status,
  captured_amount: '0',
  refunded_amount: '0',
  updated_at: '2026-10-14T10:00:00.000Z',
})

describe('the live state', () => {
  it('keeps the newest journals once each and files their entries under the right T-account and side', () => {
    let state = EMPTY
    state = reduce(state, { type: 'journal', data: journal('7', [['psp_receivable:EUR', '2400'], ['merchant_payable:wash_north', '-2342'], ['platform_fee_revenue:EUR', '-58']]), at: 1 })
    state = reduce(state, { type: 'journal', data: journal('5', [['psp_receivable:EUR', '900'], ['merchant_payable:wash_north', '-900']]), at: 2 })
    state = reduce(state, { type: 'journal', data: journal('7', []), at: 3 })
    expect(state.journals.map((j) => j.id)).toEqual(['7', '5'])
    expect(state.postings.receivable!.map((p) => [p.side, p.amount])).toEqual([['debit', 900n], ['debit', 2400n]])
    expect(state.postings.drawer!.map((p) => [p.side, p.amount])).toEqual([['credit', 58n]])
    expect(state.fresh.payables).toBe(2)
  })

  it('shows each payment once, in its latest state, newest first', () => {
    let state = EMPTY
    state = reduce(state, { type: 'payment', data: payment('0199a', 'authorized'), at: 1 })
    state = reduce(state, { type: 'payment', data: payment('0199b', 'captured'), at: 2 })
    state = reduce(state, { type: 'payment', data: payment('0199a', 'captured'), at: 3 })
    expect(state.payments.map((p) => [p.id, p.status])).toEqual([
      ['0199b', 'captured'],
      ['0199a', 'captured'],
    ])
  })

  it('adds merchants into one payables book and sees when the books do not balance', () => {
    const balanced = totals([
      { code: 'psp_receivable:EUR', type: 'asset', currency: 'EUR', amount: '3300' },
      { code: 'merchant_payable:wash_north', type: 'liability', currency: 'EUR', amount: '-2000' },
      { code: 'merchant_payable:wash_south', type: 'liability', currency: 'EUR', amount: '-1242' },
      { code: 'platform_fee_revenue:EUR', type: 'revenue', currency: 'EUR', amount: '-58' },
    ])
    expect(balanced.net).toBe(0n)
    expect(balanced.books.get('payables')).toMatchObject({ amount: -3242n })
    expect(totals([{ code: 'bank:EUR', type: 'asset', currency: 'EUR', amount: '1' }]).net).toBe(1n)
  })

  it('formats cents as euros with the sign in front', () => {
    expect(money(2400)).toBe('€24.00')
    expect(money('-58')).toBe('-€0.58')
    expect(money(123456789n)).toBe('€1,234,567.89')
  })
})
