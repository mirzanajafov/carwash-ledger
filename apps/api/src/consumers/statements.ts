import { EntryPostedData } from '@carwash/contracts'
import { TOPICS, type ConsumerSpec } from '@carwash/outbox'
import * as z from 'zod/mini'
import { merchantAccountCode } from '../ledger/account-codes.ts'

const PostedEntry = z.pick(EntryPostedData, { account_id: true, account: true, amount: true, posted_at: true })

type PostedEntry = z.infer<typeof PostedEntry>

interface DayTotal {
  accountId: string
  day: string
  debits: bigint
  credits: bigint
  entries: number
}

const MERCHANT_PREFIX = merchantAccountCode('')

const ADD = `
  INSERT INTO statements (account_id, day, debits, credits, entries)
  SELECT * FROM unnest($1::bigint[], $2::date[], $3::bigint[], $4::bigint[], $5::int[])
  ON CONFLICT (account_id, day) DO UPDATE SET
    debits = statements.debits + excluded.debits,
    credits = statements.credits + excluded.credits,
    entries = statements.entries + excluded.entries`

export function dayTotals(entries: readonly PostedEntry[]): DayTotal[] {
  const totals = new Map<string, DayTotal>()
  for (const entry of entries) {
    if (!entry.account.startsWith(MERCHANT_PREFIX)) continue
    const day = new Date(entry.posted_at).toISOString().slice(0, 10)
    const key = `${entry.account_id}:${day}`
    const total = totals.get(key) ?? { accountId: entry.account_id, day, debits: 0n, credits: 0n, entries: 0 }
    const amount = BigInt(entry.amount)
    if (amount > 0n) total.debits += amount
    else total.credits -= amount
    total.entries++
    totals.set(key, total)
  }
  return [...totals.values()].sort((a, b) => (a.accountId === b.accountId ? a.day.localeCompare(b.day) : Number(BigInt(a.accountId) - BigInt(b.accountId))))
}

export const statements: ConsumerSpec = {
  name: 'statements',
  topic: TOPICS.ledger,
  apply: async (client, events) => {
    const totals = dayTotals(events.filter((event) => event.type === 'entry.posted').map((event) => PostedEntry.parse(event.data)))
    if (totals.length === 0) return
    await client.query(ADD, [
      totals.map((t) => t.accountId),
      totals.map((t) => t.day),
      totals.map((t) => t.debits.toString()),
      totals.map((t) => t.credits.toString()),
      totals.map((t) => t.entries),
    ])
  },
}
