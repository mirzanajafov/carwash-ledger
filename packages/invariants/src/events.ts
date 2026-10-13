import type pg from 'pg'
import { collect, inSnapshot, type Check } from './collect.ts'
import type { InvariantResult } from './types.ts'

const SUBSCRIPTIONS = `(VALUES ('receipts', 'payments'), ('statements', 'ledger')) AS s(consumer, topic)`

const DELIVERED: readonly Check[] = [
  {
    sql: `
      SELECT 'event ' || o.event_id || ' (' || o.type || ' for ' || o.key || ') is still in the outbox' AS detail
      FROM outbox o
      WHERE o.published_at IS NULL`,
  },
  {
    sql: `
      SELECT 'event ' || o.event_id || ' (' || o.type || ' for ' || o.key || ') never reached ' || s.consumer AS detail
      FROM ${SUBSCRIPTIONS}
      JOIN outbox o ON o.topic = s.topic
      WHERE o.published_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.consumer = s.consumer AND i.event_id = o.event_id)`,
  },
]

const CAPTURES = `
  WITH captures AS (
    SELECT substr(j.external_ref, 9)::uuid AS payment_id, sum(e.amount) FILTER (WHERE e.amount > 0) AS amount
    FROM journals j
    JOIN entries e ON e.journal_id = j.id
    WHERE j.external_ref LIKE 'capture:%'
    GROUP BY j.id
  )`

const CONSUMED: readonly Check[] = [
  {
    sql: `${CAPTURES}
      SELECT 'payment ' || c.payment_id || ' captured ' || c.amount || ' and has ' || count(r.id) || ' receipts'
             || coalesce(' for ' || string_agg(r.amount::text, ', '), '') AS detail
      FROM captures c
      LEFT JOIN receipts r ON r.payment_id = c.payment_id
      GROUP BY c.payment_id, c.amount
      HAVING count(r.id) <> 1 OR bool_or(r.amount <> c.amount)`,
  },
  {
    sql: `
      SELECT 'receipt ' || r.merchant || ' #' || r.number || ' is for payment ' || r.payment_id || ', which was never captured' AS detail
      FROM receipts r
      WHERE NOT EXISTS (SELECT 1 FROM journals j WHERE j.external_ref = 'capture:' || r.payment_id)`,
  },
  {
    sql: `
      SELECT 'merchant ' || r.merchant || ' has ' || count(*) || ' receipts numbered ' || min(r.number) || ' to ' || max(r.number)
             || ', its counter is at ' || coalesce(c.last_number::text, 'nothing') AS detail
      FROM receipts r
      LEFT JOIN receipt_counters c ON c.merchant = r.merchant
      GROUP BY r.merchant, c.last_number
      HAVING min(r.number) <> 1 OR max(r.number) <> count(*) OR c.last_number IS DISTINCT FROM max(r.number)`,
  },
  {
    sql: `
      WITH ledger AS (
        SELECT e.account_id, (j.created_at AT TIME ZONE 'UTC')::date AS day,
               coalesce(sum(e.amount) FILTER (WHERE e.amount > 0), 0) AS debits,
               coalesce(-sum(e.amount) FILTER (WHERE e.amount < 0), 0) AS credits,
               count(*)::int AS entries
        FROM entries e
        JOIN journals j ON j.id = e.journal_id
        JOIN merchants m ON m.account_id = e.account_id
        GROUP BY e.account_id, (j.created_at AT TIME ZONE 'UTC')::date
      )
      SELECT 'account ' || coalesce(l.account_id, s.account_id) || ' on ' || coalesce(l.day, s.day)
             || ': the ledger has ' || coalesce(l.debits || ' debited, ' || l.credits || ' credited in ' || l.entries || ' entries', 'nothing')
             || ', the statement ' || coalesce(s.debits || ' debited, ' || s.credits || ' credited in ' || s.entries || ' entries', 'nothing') AS detail
      FROM ledger l
      FULL JOIN statements s ON s.account_id = l.account_id AND s.day = l.day
      WHERE l.debits IS DISTINCT FROM s.debits OR l.credits IS DISTINCT FROM s.credits OR l.entries IS DISTINCT FROM s.entries`,
  },
]

export async function checkEventsIn(client: pg.ClientBase): Promise<InvariantResult[]> {
  const l2 = await collect(client, DELIVERED)
  const l3 = await collect(client, CONSUMED)
  return [
    { id: 'L2', description: 'the outbox is empty and every consumer has every event of its topic', ...l2 },
    { id: 'L3', description: 'every captured payment has one receipt, numbered without gaps, and the statements equal the ledger', ...l3 },
  ]
}

export function checkEvents(pool: pg.Pool): Promise<InvariantResult[]> {
  return inSnapshot(pool, checkEventsIn)
}
