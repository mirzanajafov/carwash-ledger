export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'

export type BalanceMode = 'locked' | 'serializable' | 'derived' | 'sharded'

export const BALANCE_MODES: readonly BalanceMode[] = ['locked', 'serializable', 'derived', 'sharded']

export interface Account {
  id: bigint
  code: string
  type: AccountType
  currency: string
  balanceMode: BalanceMode
  shards: number
}

export interface EntryInput {
  accountId: bigint
  amount: bigint
}

export interface JournalInput {
  externalRef: string
  entries: readonly EntryInput[]
  reversesId?: bigint | undefined
}

export interface PostedJournal {
  id: bigint
  externalRef: string
  attempts: number
}

export interface Poster {
  readonly name: string
  post(input: JournalInput): Promise<PostedJournal>
}
