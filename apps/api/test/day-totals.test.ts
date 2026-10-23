import { describe, expect, it } from 'vitest'
import { dayTotals } from '../src/consumers/statements.ts'

describe('the merchant statement totals', () => {
  const entry = (account: string, amount: string, at: string) => ({ account_id: account === 'merchant_payable:a' ? '7' : '9', account, amount, posted_at: at })

  it('adds up merchant entries per account and UTC day, debits and credits apart, and skips other accounts', () => {
    expect(
      dayTotals([
        entry('merchant_payable:a', '-1460', '2026-10-13T23:59:59.900+02:00'),
        entry('merchant_payable:a', '500', '2026-10-13T21:00:00Z'),
        entry('merchant_payable:a', '-900', '2026-10-14T00:00:00Z'),
        entry('psp_receivable:EUR', '1500', '2026-10-13T12:00:00Z'),
      ]),
    ).toEqual([
      { accountId: '7', day: '2026-10-13', debits: 500n, credits: 1460n, entries: 2 },
      { accountId: '7', day: '2026-10-14', debits: 0n, credits: 900n, entries: 1 },
    ])
  })
})
