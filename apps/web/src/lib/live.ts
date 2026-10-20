import { bookOf, type Side } from './accounts'

export interface Balance {
  code: string
  type: string
  currency: string
  amount: string
}

export interface Journal {
  id: string
  external_ref: string
  posted_at: string
  entries: { account: string; amount: string }[]
}

export interface Payment {
  id: string
  merchant: string
  amount: string
  currency: string
  status: string
  captured_amount: string
  refunded_amount: string
  updated_at: string
}

export interface Posting {
  journal: string
  ref: string
  side: Side
  amount: bigint
  at: string
}

export interface LiveState {
  balances: Balance[]
  journals: Journal[]
  payments: Payment[]
  postings: Record<string, Posting[]>
  fresh: Record<string, number>
  updatedAt: number | null
}

export type LiveAction =
  { type: 'balances'; data: Balance[]; at: number } | { type: 'journal'; data: Journal; at: number } | { type: 'payment'; data: Payment; at: number }

export const EMPTY: LiveState = { balances: [], journals: [], payments: [], postings: {}, fresh: {}, updatedAt: null }

const JOURNALS = 8
const PAYMENTS = 8
const POSTINGS = 4

export function reduce(state: LiveState, action: LiveAction): LiveState {
  if (action.type === 'balances') return { ...state, balances: action.data, updatedAt: action.at }
  if (action.type === 'journal') {
    if (state.journals.some((j) => j.id === action.data.id)) return state
    const journals = [action.data, ...state.journals].sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))).slice(0, JOURNALS)
    const postings = { ...state.postings }
    const fresh = { ...state.fresh }
    for (const entry of action.data.entries) {
      const book = bookOf(entry.account)
      if (!book) continue
      const amount = BigInt(entry.amount)
      const posting: Posting = {
        journal: action.data.id,
        ref: action.data.external_ref,
        side: amount > 0n ? 'debit' : 'credit',
        amount: amount < 0n ? -amount : amount,
        at: action.data.posted_at,
      }
      postings[book.key] = [posting, ...(postings[book.key] ?? [])].slice(0, POSTINGS)
      fresh[book.key] = action.at
    }
    return { ...state, journals, postings, fresh, updatedAt: action.at }
  }
  const others = state.payments.filter((p) => p.id !== action.data.id)
  const payments = [action.data, ...others].sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, PAYMENTS)
  return { ...state, payments, updatedAt: action.at }
}

export interface BookTotal {
  key: string
  amount: bigint
  accounts: { code: string; amount: bigint }[]
}

export function totals(balances: readonly Balance[]): { books: Map<string, BookTotal>; net: bigint } {
  const books = new Map<string, BookTotal>()
  let net = 0n
  for (const balance of balances) {
    const amount = BigInt(balance.amount)
    net += amount
    const book = bookOf(balance.code)
    if (!book) continue
    const total = books.get(book.key) ?? { key: book.key, amount: 0n, accounts: [] }
    total.amount += amount
    total.accounts.push({ code: balance.code, amount })
    books.set(book.key, total)
  }
  return { books, net }
}
