import { inSnapshot } from '@carwash/pg'
import type pg from 'pg'
import { collect, EXAMPLES, type Check, type Finding } from './collect.ts'
import type { InvariantResult } from './types.ts'

const MONEY = `
  WITH money AS (
    SELECT j.id, j.external_ref, sum(e.amount) FILTER (WHERE e.amount > 0) AS gross
    FROM journals j
    JOIN entries e ON e.journal_id = j.id
    WHERE j.external_ref LIKE 'capture:%' OR j.external_ref LIKE 'refund:%'
       OR j.external_ref LIKE 'payout:%' OR j.external_ref LIKE 'payout-reversal:%' OR j.external_ref LIKE 'payout-adjustment:%'
    GROUP BY j.id
  )`

const PAYMENTS_AGREE: readonly Check[] = [
  {
    sql: `
      SELECT 'payment ' || substr(external_ref, 9) || ' has ' || count(*) || ' capture journals' AS detail
      FROM journals
      WHERE external_ref LIKE 'capture:%'
      GROUP BY external_ref
      HAVING count(*) > 1`,
  },
  {
    sql: `${MONEY}
      SELECT 'payment ' || p.id || ' is ' || p.status || ' with ' || p.captured_amount || ' captured, its capture journals hold '
             || count(m.id) || ' for ' || coalesce(sum(m.gross), 0) AS detail
      FROM payments p
      LEFT JOIN money m ON m.external_ref = 'capture:' || p.id
      GROUP BY p.id, p.status, p.captured_amount
      HAVING count(m.id) <> CASE WHEN p.status IN ('captured', 'refunded') THEN 1 ELSE 0 END
          OR coalesce(sum(m.gross), 0) <> p.captured_amount`,
  },
  {
    sql: `${MONEY}
      SELECT 'refund ' || r.id || ' is ' || r.status || ' for ' || r.amount || ', its journals hold '
             || count(m.id) || ' for ' || coalesce(sum(m.gross), 0) AS detail
      FROM refunds r
      LEFT JOIN money m ON m.external_ref = 'refund:' || r.id
      GROUP BY r.id, r.status, r.amount
      HAVING count(m.id) <> CASE WHEN r.status = 'succeeded' THEN 1 ELSE 0 END
          OR coalesce(sum(m.gross), 0) <> CASE WHEN r.status = 'succeeded' THEN r.amount ELSE 0 END`,
  },
  {
    sql: `${MONEY}, refunded AS (
        SELECT r.payment_id, sum(m.gross) AS amount
        FROM refunds r
        JOIN money m ON m.external_ref = 'refund:' || r.id
        GROUP BY r.payment_id
      ), captured AS (
        SELECT p.id AS payment_id, p.refunded_amount, coalesce(sum(m.gross), 0) AS amount
        FROM payments p
        LEFT JOIN money m ON m.external_ref = 'capture:' || p.id
        GROUP BY p.id, p.refunded_amount
      )
      SELECT 'payment ' || c.payment_id || ' has ' || coalesce(f.amount, 0) || ' refunded in the ledger and '
             || c.refunded_amount || ' on its record, against ' || c.amount || ' captured' AS detail
      FROM captured c
      LEFT JOIN refunded f ON f.payment_id = c.payment_id
      WHERE coalesce(f.amount, 0) > c.amount OR coalesce(f.amount, 0) <> c.refunded_amount`,
  },
]

function createdBy(window: number): readonly Check[] {
  const recent = (table: string) => `${table}.created_at > now() - make_interval(secs => ${window})`
  return [
    {
      sql: `
        SELECT 'payment ' || p.id || ' was created by ' || count(k.key) || ' idempotency keys of its client' AS detail
        FROM payments p
        LEFT JOIN idempotency_keys k ON k.payment_id = p.id AND k.refund_id IS NULL AND k.path = '/v1/payments' AND k.client_id = p.client_id
        WHERE ${recent('p')}
        GROUP BY p.id
        HAVING count(k.key) <> 1`,
    },
    {
      sql: `
        SELECT 'refund ' || r.id || ' was created by ' || count(k.key) || ' idempotency keys' AS detail
        FROM refunds r
        LEFT JOIN idempotency_keys k ON k.refund_id = r.id
        WHERE ${recent('r')}
        GROUP BY r.id
        HAVING count(k.key) <> 1`,
    },
    {
      sql: `
        SELECT 'payout ' || po.id || ' was created by ' || count(k.key) || ' idempotency keys' AS detail
        FROM payouts po
        LEFT JOIN idempotency_keys k ON k.payout_id = po.id
        WHERE ${recent('po')}
        GROUP BY po.id
        HAVING count(k.key) <> 1`,
    },
  ]
}

const PAYOUTS_COVERED: readonly Check[] = [
  {
    sql: `
      WITH replay AS (
        SELECT m.code, e.journal_id, e.amount,
               coalesce(sum(e.amount) OVER (
                 PARTITION BY e.account_id ORDER BY e.journal_id, e.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ), 0) AS before
        FROM merchants m
        JOIN entries e ON e.account_id = m.account_id
      )
      SELECT 'merchant ' || r.code || ' was paid out ' || r.amount || ' in journal ' || r.journal_id
             || ' with ' || -r.before || ' payable before it in journal order' AS detail
      FROM replay r
      JOIN journals j ON j.id = r.journal_id
      WHERE j.external_ref LIKE 'payout:%' AND -r.before < r.amount`,
  },
]

const STILL_PENDING: readonly Check[] = [
  {
    sql: `
      SELECT 'attempt ' || a.id || ' (' || a.kind || ' of ' || a.amount || ') is still pending' AS detail
      FROM attempts a
      WHERE a.status = 'pending' AND NOT EXISTS (SELECT 1 FROM anomalies n WHERE n.attempt_id = a.id)`,
  },
]

export interface PaymentChecks {
  keyWindowSeconds?: number
}

const DAY = 24 * 3600
const MARGIN = 300

export async function checkPaymentsIn(client: pg.ClientBase, options: PaymentChecks = {}): Promise<InvariantResult[]> {
  const window = Math.max(0, Math.floor(options.keyWindowSeconds ?? DAY) - MARGIN)
  const s3 = await collect(client, PAYMENTS_AGREE)
  const s5 = await collect(client, createdBy(window))
  const s6 = await collect(client, PAYOUTS_COVERED)
  return [
    {
      id: 'S3',
      description: 'every payment has the one capture journal its state says, and its refund journals never exceed it',
      ...s3,
    },
    { id: 'S5', description: 'every payment, refund and payout was created by exactly one idempotency key', ...s5 },
    { id: 'S6', description: "replaying each merchant's entries in journal order, the payable covers every payout", ...s6 },
  ]
}

export function checkPayments(pool: pg.Pool, options: PaymentChecks = {}): Promise<InvariantResult[]> {
  return inSnapshot(pool, (client) => checkPaymentsIn(client, options))
}

export async function checkSettledIn(client: pg.ClientBase): Promise<InvariantResult> {
  const l1 = await collect(client, STILL_PENDING)
  return { id: 'L1', description: 'no attempt is left pending unless its answer was refused as an anomaly', ...l1 }
}

export function checkSettled(pool: pg.Pool): Promise<InvariantResult> {
  return inSnapshot(pool, checkSettledIn)
}

interface PspOperation {
  id: string
  key: string
  kind: string
  status: string
  amount: string | null
}

interface LedgerAttempt {
  id: string
  kind: string
  status: string
  amount: string
  operation: string | null
  parent: string
}

const PSP_OPERATIONS = `
  SELECT id, idempotency_key AS key, kind, status, amount::text
  FROM operations
  WHERE kind IN ('capture', 'refund', 'payout')`

const LEDGER_ATTEMPTS = `
  SELECT id::text, kind::text, status::text, amount::text, psp_operation_id AS operation,
         coalesce(refund_id, payout_id, payment_id)::text AS parent
  FROM attempts
  WHERE kind IN ('capture', 'refund', 'payout')`

const LEDGER_MONEY = `${MONEY}
  SELECT external_ref, count(*)::int AS journals, sum(gross)::text AS gross
  FROM money
  GROUP BY external_ref`

const JOURNAL_PREFIX: Record<string, string> = { capture: 'capture:', refund: 'refund:', payout: 'payout:' }
const DID: Record<string, string> = { capture: 'captured', refund: 'refunded' }

async function readOperations(psp: pg.Pool | pg.ClientBase): Promise<Map<string, PspOperation>> {
  const { rows } = await psp.query<PspOperation>(PSP_OPERATIONS)
  return new Map(rows.map((row) => [row.key, row]))
}

export function comparePsp(
  before: ReadonlyMap<string, PspOperation>,
  attempts: readonly LedgerAttempt[],
  money: ReadonlyMap<string, { journals: number; gross: string }>,
  after: ReadonlyMap<string, PspOperation>,
): Finding {
  const found: string[] = []
  const byId = new Map(attempts.map((a) => [a.id, a]))
  for (const op of before.values()) {
    const attempt = byId.get(op.key)
    if (attempt === undefined) found.push(`the PSP did ${op.kind} ${op.id} (${op.status}) for ${op.key}, which the ledger never asked for`)
    else if (attempt.status !== 'pending' && (attempt.status !== op.status || attempt.operation !== op.id)) {
      found.push(`the PSP ${op.status} ${op.kind} ${op.key} as ${op.id}, the ledger has it ${attempt.status} as ${attempt.operation}`)
    }
  }
  const succeeded = new Set<string>()
  for (const attempt of attempts) {
    if (attempt.status === 'pending') continue
    const op = after.get(attempt.id)
    if (op === undefined) {
      found.push(`the ledger has ${attempt.kind} ${attempt.id} ${attempt.status}, the PSP has no operation for it`)
      continue
    }
    const ref = JOURNAL_PREFIX[attempt.kind]! + attempt.parent
    const journal = money.get(ref)
    if (attempt.kind === 'payout') {
      const reversal = money.get(`payout-reversal:${attempt.parent}`)
      const adjustment = money.get(`payout-adjustment:${attempt.parent}`)
      const net = journal === undefined ? undefined : (BigInt(journal.gross) - BigInt(adjustment?.gross ?? 0)).toString()
      if (net !== attempt.amount) {
        found.push(`payout ${attempt.parent} of ${attempt.amount} has ${net ?? 'no'} journal${adjustment ? ' after its adjustment' : ''}`)
      }
      if (op.status === 'succeeded' && op.amount !== attempt.amount) {
        found.push(`the PSP paid out ${op.amount} for payout ${attempt.parent}, the ledger moved ${attempt.amount}`)
      }
      if ((op.status === 'declined') !== (reversal !== undefined)) {
        found.push(`the PSP ${op.status} payout ${attempt.parent}, the ledger ${reversal === undefined ? 'did not reverse' : 'reversed'} it`)
      }
      continue
    }
    if (op.status !== 'succeeded') continue
    succeeded.add(ref)
    if (journal === undefined) found.push(`the PSP ${DID[attempt.kind]} ${op.amount} for ${ref}, the ledger has no journal`)
    else if (journal.journals !== 1 || journal.gross !== op.amount) {
      found.push(`the PSP ${DID[attempt.kind]} ${op.amount} for ${ref}, the ledger has ${journal.journals} journals for ${journal.gross}`)
    }
  }
  for (const [ref, journal] of money) {
    if ((ref.startsWith('capture:') || ref.startsWith('refund:')) && !succeeded.has(ref)) {
      found.push(`${ref} has ${journal.journals} journals for ${journal.gross}, the PSP did no such operation`)
    }
  }
  return { count: found.length, examples: found.slice(0, EXAMPLES) }
}

export async function checkAgainstPsp(ledger: pg.Pool, psp: pg.Pool | pg.ClientBase): Promise<InvariantResult> {
  const before = await readOperations(psp)
  const { attempts, money } = await inSnapshot(ledger, async (client) => {
    const attempts = (await client.query<LedgerAttempt>(LEDGER_ATTEMPTS)).rows
    const journals = await client.query<{ external_ref: string; journals: number; gross: string }>(LEDGER_MONEY)
    return { attempts, money: new Map(journals.rows.map((row) => [row.external_ref, row])) }
  })
  const after = await readOperations(psp)
  return {
    id: 'S4',
    description: 'the ledger and the PSP agree on every capture, refund and payout',
    ...comparePsp(before, attempts, money, after),
  }
}
