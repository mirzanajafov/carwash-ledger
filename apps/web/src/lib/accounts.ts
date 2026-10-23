import { PROGRAMS } from '@carwash/contracts'

export type Side = 'debit' | 'credit'

export interface Book {
  key: string
  title: string
  note: string
  normal: Side
  match: (code: string) => boolean
}

export const BOOKS: readonly Book[] = [
  { key: 'receivable', title: 'PSP receivable', note: 'what the payment provider owes us', normal: 'debit', match: (c) => c.startsWith('psp_receivable:') },
  { key: 'payables', title: 'Merchant payables', note: 'what we owe the car washes', normal: 'credit', match: (c) => c.startsWith('merchant_payable:') },
  { key: 'drawer', title: 'Cash drawer', note: 'our fee on every wash', normal: 'credit', match: (c) => c.startsWith('platform_fee_revenue:') },
  { key: 'pspFees', title: 'PSP fees', note: 'what the provider keeps', normal: 'debit', match: (c) => c.startsWith('psp_fee_expense:') },
  { key: 'bank', title: 'Bank', note: 'settled money, paid out', normal: 'debit', match: (c) => c.startsWith('bank:') },
  { key: 'suspense', title: 'Suspense', note: 'money nobody has placed yet', normal: 'credit', match: (c) => c.startsWith('suspense:') },
]

export function bookOf(code: string): Book | undefined {
  return BOOKS.find((book) => book.match(code))
}

export function merchantName(code: string): string {
  const name = code
    .replace(/^merchant_payable:/, '')
    .replace(/^wash_/, '')
    .replaceAll('_', ' ')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function programOf(amount: string | number): string {
  return PROGRAMS.find((program) => program.price === Number(amount))?.name ?? 'Custom'
}

export function journalKind(ref: string): string {
  const kind = ref.split(':')[0] ?? ref
  return { capture: 'Capture', refund: 'Refund', payout: 'Payout', settlement: 'Settlement', reversal: 'Reversal' }[kind] ?? kind
}
