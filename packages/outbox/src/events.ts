import type { Transaction } from '@carwash/pg'

export const LANES = 16

export const TOPICS = { payments: 'payments', ledger: 'ledger' } as const

export type Topic = (typeof TOPICS)[keyof typeof TOPICS]

export interface NewEvent {
  topic: Topic
  key: string
  type: string
  payload: unknown
}

export interface Envelope {
  id: string
  type: string
  occurred_at: string
  data: unknown
}

export function laneSql(key: string): string {
  return `(hashtextextended(${key}, 0) & ${LANES - 1})::smallint`
}

export async function writeEvent(client: Transaction, event: NewEvent): Promise<void> {
  await client.query(`INSERT INTO outbox (topic, key, lane, type, payload) VALUES ($1, $2, ${laneSql('$2')}, $3, $4)`, [
    event.topic,
    event.key,
    event.type,
    JSON.stringify(event.payload),
  ])
}

export async function writeJournalEvents(client: Transaction, journalId: bigint): Promise<number> {
  const { rowCount } = await client.query(
    `INSERT INTO outbox (topic, key, lane, type, payload)
     SELECT '${TOPICS.ledger}', e.account_id::text, ${laneSql('e.account_id::text')}, 'entry.posted',
            jsonb_build_object(
              'journal_id', j.id::text, 'entry_id', e.id::text, 'external_ref', j.external_ref,
              'account_id', e.account_id::text, 'account', a.code, 'currency', a.currency,
              'amount', e.amount::text, 'posted_at', j.created_at)
     FROM entries e
     JOIN journals j ON j.id = e.journal_id
     JOIN accounts a ON a.id = e.account_id
     WHERE e.journal_id = $1
     ORDER BY e.id`,
    [journalId],
  )
  return rowCount ?? 0
}
