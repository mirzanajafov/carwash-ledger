import { firstRow, inSnapshot, type Queryable, type Transaction } from '@carwash/pg'
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

const ALL_PAYMENTS = 'SELECT p.id FROM payments p'

const TOUCHED_PAYMENTS = `
  SELECT p.id FROM payments p
  WHERE p.updated_xid >= pg_snapshot_xmin($1::pg_snapshot) AND NOT pg_visible_in_snapshot(p.updated_xid, $1::pg_snapshot)
  UNION
  SELECT r.payment_id FROM refunds r
  WHERE r.updated_xid >= pg_snapshot_xmin($1::pg_snapshot) AND NOT pg_visible_in_snapshot(r.updated_xid, $1::pg_snapshot)
  UNION
  SELECT p.id FROM payments p
  WHERE p.id IN (
    SELECT substr(j.external_ref, 9)::uuid FROM journals j
    WHERE j.created_xid >= pg_snapshot_xmin($1::pg_snapshot) AND NOT pg_visible_in_snapshot(j.created_xid, $1::pg_snapshot)
      AND j.external_ref LIKE 'capture:%' AND pg_input_is_valid(substr(j.external_ref, 9), 'uuid')
  )
  UNION
  SELECT r.payment_id FROM refunds r
  WHERE r.id IN (
    SELECT substr(j.external_ref, 8)::uuid FROM journals j
    WHERE j.created_xid >= pg_snapshot_xmin($1::pg_snapshot) AND NOT pg_visible_in_snapshot(j.created_xid, $1::pg_snapshot)
      AND j.external_ref LIKE 'refund:%' AND pg_input_is_valid(substr(j.external_ref, 8), 'uuid')
  )`

interface Scope {
  sql: string
  params: unknown[]
}

const GROSS = 'coalesce(sum(e.amount) FILTER (WHERE e.amount > 0), 0)'

function paymentsAgree({ sql, params }: Scope): readonly Check[] {
  return [
    {
      sql: `WITH scope AS (${sql})
        SELECT 'payment ' || s.id || ' has ' || count(*) || ' capture journals' AS detail
        FROM scope s
        JOIN journals j ON j.external_ref = 'capture:' || s.id
        GROUP BY s.id
        HAVING count(*) > 1`,
      params,
    },
    {
      sql: `WITH scope AS (${sql})
        SELECT 'payment ' || p.id || ' is ' || p.status || ' with ' || p.captured_amount || ' captured, its capture journals hold '
               || count(DISTINCT j.id) || ' for ' || ${GROSS} AS detail
        FROM scope s
        JOIN payments p ON p.id = s.id
        LEFT JOIN journals j ON j.external_ref = 'capture:' || p.id
        LEFT JOIN entries e ON e.journal_id = j.id
        GROUP BY p.id, p.status, p.captured_amount
        HAVING count(DISTINCT j.id) <> CASE WHEN p.status IN ('captured', 'refunded') THEN 1 ELSE 0 END
            OR ${GROSS} <> p.captured_amount`,
      params,
    },
    {
      sql: `WITH scope AS (${sql})
        SELECT 'refund ' || r.id || ' is ' || r.status || ' for ' || r.amount || ', its journals hold '
               || count(DISTINCT j.id) || ' for ' || ${GROSS} AS detail
        FROM scope s
        JOIN refunds r ON r.payment_id = s.id
        LEFT JOIN journals j ON j.external_ref = 'refund:' || r.id
        LEFT JOIN entries e ON e.journal_id = j.id
        GROUP BY r.id, r.status, r.amount
        HAVING count(DISTINCT j.id) <> CASE WHEN r.status = 'succeeded' THEN 1 ELSE 0 END
            OR ${GROSS} <> CASE WHEN r.status = 'succeeded' THEN r.amount ELSE 0 END`,
      params,
    },
    {
      sql: `WITH scope AS (${sql}), captured AS (
          SELECT p.id, p.refunded_amount, ${GROSS} AS amount
          FROM scope s
          JOIN payments p ON p.id = s.id
          LEFT JOIN journals j ON j.external_ref = 'capture:' || p.id
          LEFT JOIN entries e ON e.journal_id = j.id
          GROUP BY p.id, p.refunded_amount
        ), refunded AS (
          SELECT r.payment_id, ${GROSS} AS amount
          FROM scope s
          JOIN refunds r ON r.payment_id = s.id
          JOIN journals j ON j.external_ref = 'refund:' || r.id
          JOIN entries e ON e.journal_id = j.id
          GROUP BY r.payment_id
        )
        SELECT 'payment ' || c.id || ' has ' || coalesce(f.amount, 0) || ' refunded in the ledger and '
               || c.refunded_amount || ' on its record, against ' || c.amount || ' captured' AS detail
        FROM captured c
        LEFT JOIN refunded f ON f.payment_id = c.id
        WHERE coalesce(f.amount, 0) > c.amount OR coalesce(f.amount, 0) <> c.refunded_amount`,
      params,
    },
  ]
}

function createdBy(window: number): readonly Check[] {
  const recent = (table: string) =>
    `${table}.id >= (SELECT uuidv7(-make_interval(secs => ${window + 60}))) AND ${table}.created_at > now() - make_interval(secs => ${window})`
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

const REPLAY_FROM = `
  start AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS s(account bigint, journal bigint, total bigint, since xid8)
  )`

const PAYOUTS_COVERED = `
  WITH ${REPLAY_FROM}, replay AS (
    SELECT m.code, e.journal_id, e.amount,
           s.total + coalesce(sum(e.amount) OVER (
             PARTITION BY e.account_id ORDER BY e.journal_id, e.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ), 0) AS before
    FROM start s
    JOIN merchants m ON m.account_id = s.account
    JOIN entries e ON e.account_id = s.account AND e.created_xid >= s.since AND e.journal_id > s.journal
  )
  SELECT 'merchant ' || r.code || ' was paid out ' || r.amount || ' in journal ' || r.journal_id
         || ' with ' || -r.before || ' payable before it in journal order' AS detail
  FROM replay r
  JOIN journals j ON j.id = r.journal_id
  WHERE j.external_ref LIKE 'payout:%' AND -r.before < r.amount`

const REPLAYED = `
  WITH ${REPLAY_FROM}
  SELECT s.account::text, coalesce(max(e.journal_id), s.journal)::text AS journal, (s.total + coalesce(sum(e.amount), 0))::text AS total,
         count(e.id)::int AS entries
  FROM start s
  LEFT JOIN entries e ON e.account_id = s.account AND e.created_xid >= s.since AND e.journal_id > s.journal
  GROUP BY s.account, s.journal, s.total`

const FIRST_NEW_ENTRIES = `
  SELECT e.account_id::text AS account, min(e.journal_id)::text AS journal, pg_snapshot_xmin($1::pg_snapshot)::text AS since
  FROM merchants m
  JOIN entries e ON e.account_id = m.account_id
  WHERE e.created_xid >= pg_snapshot_xmin($1::pg_snapshot) AND NOT pg_visible_in_snapshot(e.created_xid, $1::pg_snapshot)
  GROUP BY e.account_id`

const STILL_PENDING: readonly Check[] = [
  {
    sql: `
      SELECT 'attempt ' || a.id || ' (' || a.kind || ' of ' || a.amount || ') is still pending' AS detail
      FROM attempts a
      WHERE a.status = 'pending' AND NOT EXISTS (SELECT 1 FROM anomalies n WHERE n.attempt_id = a.id)`,
  },
]

export interface MerchantReplay {
  account: string
  journal: string
  total: string
}

export interface PaymentBase {
  snapshot: string
  takenAt: Date
  merchants: MerchantReplay[]
}

export interface PaymentChecks {
  keyWindowSeconds?: number
  since?: PaymentBase | undefined
}

export interface PaymentChecksRun {
  results: InvariantResult[]
  since: PaymentBase | undefined
  payments: number
  entries: number
  base: PaymentBase | undefined
}

interface ReplayStart extends MerchantReplay {
  since: string
}

const FROM_THE_FIRST_ENTRY = { journal: '-9223372036854775808', total: '0', since: '0' }

async function replayStarts(client: Transaction, since: PaymentBase | undefined): Promise<ReplayStart[]> {
  if (!since) {
    const { rows } = await client.query<{ account: string }>('SELECT m.account_id::text AS account FROM merchants m')
    return rows.map((row) => ({ account: row.account, ...FROM_THE_FIRST_ENTRY }))
  }
  const replayed = new Map(since.merchants.map((merchant) => [merchant.account, merchant]))
  const { rows } = await client.query<{ account: string; journal: string; since: string }>(FIRST_NEW_ENTRIES, [since.snapshot])
  return rows.map((row) => {
    const before = replayed.get(row.account)
    return before && BigInt(row.journal) > BigInt(before.journal) ? { ...before, since: row.since } : { account: row.account, ...FROM_THE_FIRST_ENTRY }
  })
}

async function payoutsCovered(client: Transaction, since: PaymentBase | undefined): Promise<{ s6: Finding; merchants: MerchantReplay[]; entries: number }> {
  const params = [JSON.stringify(await replayStarts(client, since))]
  const s6 = await collect(client, [{ sql: PAYOUTS_COVERED, params }])
  const { rows } = await client.query<MerchantReplay & { entries: number }>(REPLAYED, params)
  const merchants = new Map(since?.merchants.map((merchant) => [merchant.account, merchant]))
  for (const { account, journal, total } of rows) merchants.set(account, { account, journal, total })
  return { s6, merchants: [...merchants.values()], entries: rows.reduce((sum, row) => sum + row.entries, 0) }
}

const DAY = 24 * 3600
const MARGIN = 300

export async function checkPaymentsIn(client: Transaction, options: PaymentChecks = {}): Promise<PaymentChecksRun> {
  const window = Math.max(0, Math.floor(options.keyWindowSeconds ?? DAY) - MARGIN)
  const now = firstRow(
    await client.query<{ snapshot: string; taken_at: Date; resumable: boolean }>(
      `SELECT pg_current_snapshot()::text AS snapshot, now() AS taken_at,
              coalesce(pg_snapshot_xmax($1::pg_snapshot) <= pg_snapshot_xmax(pg_current_snapshot()), false) AS resumable`,
      [options.since?.snapshot ?? null],
    ),
  )
  const since = now.resumable ? options.since : undefined
  const scope: Scope = since ? { sql: TOUCHED_PAYMENTS, params: [since.snapshot] } : { sql: ALL_PAYMENTS, params: [] }
  const looked = await client.query<{ payments: number }>(`SELECT count(*)::int AS payments FROM (${scope.sql}) AS s`, scope.params)
  const s3 = await collect(client, paymentsAgree(scope))
  const s5 = await collect(client, createdBy(window))
  const { s6, merchants, entries } = await payoutsCovered(client, since)
  return {
    results: [
      {
        id: 'S3',
        description: 'every payment has the one capture journal its state says, and its refund journals never exceed it',
        ...s3,
      },
      { id: 'S5', description: 'every payment, refund and payout was created by exactly one idempotency key', ...s5 },
      { id: 'S6', description: "replaying each merchant's entries in journal order, the payable covers every payout", ...s6 },
    ],
    since,
    payments: firstRow(looked).payments,
    entries,
    base: s3.count === 0 && s6.count === 0 ? { snapshot: now.snapshot, takenAt: now.taken_at, merchants } : undefined,
  }
}

export async function checkPayments(pool: pg.Pool, options: Omit<PaymentChecks, 'since'> = {}): Promise<InvariantResult[]> {
  return (await inSnapshot(pool, (client) => checkPaymentsIn(client, options))).results
}

const CURSOR = 'payments'

function isInteger(field: unknown): boolean {
  return typeof field === 'string' && /^-?\d+$/.test(field)
}

function isReplay(value: unknown): value is MerchantReplay {
  return (
    typeof value === 'object' &&
    value !== null &&
    'account' in value &&
    'journal' in value &&
    'total' in value &&
    isInteger(value.account) &&
    isInteger(value.journal) &&
    isInteger(value.total)
  )
}

async function readBase(pool: pg.Pool): Promise<PaymentBase | undefined> {
  const { rows } = await pool.query<{ snapshot: string; taken_at: Date; merchants: unknown }>(
    'SELECT c.snapshot::text, c.taken_at, c.merchants FROM invariant_cursors c WHERE c.name = $1',
    [CURSOR],
  )
  const row = rows[0]
  if (!row || !Array.isArray(row.merchants) || !row.merchants.every(isReplay)) return undefined
  return { snapshot: row.snapshot, takenAt: row.taken_at, merchants: row.merchants }
}

export async function checkPaymentsIncrementally(pool: pg.Pool, options: Omit<PaymentChecks, 'since'> = {}): Promise<PaymentChecksRun> {
  const since = await readBase(pool)
  const run = await inSnapshot(pool, (client) => checkPaymentsIn(client, { ...options, since }))
  if (run.base) {
    await pool.query(
      `INSERT INTO invariant_cursors AS c (name, snapshot, taken_at, merchants) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET snapshot = EXCLUDED.snapshot, taken_at = EXCLUDED.taken_at, merchants = EXCLUDED.merchants
       WHERE pg_snapshot_xmax(c.snapshot) <= pg_snapshot_xmax(EXCLUDED.snapshot)
          OR pg_snapshot_xmax(c.snapshot) > pg_snapshot_xmax(pg_current_snapshot())`,
      [CURSOR, run.base.snapshot, run.base.takenAt, JSON.stringify(run.base.merchants)],
    )
  }
  return run
}

export async function checkSettledIn(client: Transaction): Promise<InvariantResult> {
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
  kind: 'capture' | 'refund' | 'payout'
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

const JOURNAL_PREFIX: Record<LedgerAttempt['kind'], string> = { capture: 'capture:', refund: 'refund:', payout: 'payout:' }
const DID: Record<'capture' | 'refund', string> = { capture: 'captured', refund: 'refunded' }

async function readOperations(psp: Queryable): Promise<Map<string, PspOperation>> {
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
      found.push(`the PSP ${op.status} ${op.kind} ${op.key} as ${op.id}, the ledger has it ${attempt.status} as ${String(attempt.operation)}`)
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
    const ref = JOURNAL_PREFIX[attempt.kind] + attempt.parent
    const journal = money.get(ref)
    if (attempt.kind === 'payout') {
      const reversal = money.get(`payout-reversal:${attempt.parent}`)
      const adjustment = money.get(`payout-adjustment:${attempt.parent}`)
      const net = journal === undefined ? undefined : (BigInt(journal.gross) - BigInt(adjustment?.gross ?? 0)).toString()
      if (net !== attempt.amount) {
        found.push(`payout ${attempt.parent} of ${attempt.amount} has ${net ?? 'no'} journal${adjustment ? ' after its adjustment' : ''}`)
      }
      if (op.status === 'succeeded' && op.amount !== attempt.amount) {
        found.push(`the PSP paid out ${String(op.amount)} for payout ${attempt.parent}, the ledger moved ${attempt.amount}`)
      }
      if ((op.status === 'declined') !== (reversal !== undefined)) {
        found.push(`the PSP ${op.status} payout ${attempt.parent}, the ledger ${reversal === undefined ? 'did not reverse' : 'reversed'} it`)
      }
      continue
    }
    if (op.status !== 'succeeded') continue
    succeeded.add(ref)
    if (journal === undefined) found.push(`the PSP ${DID[attempt.kind]} ${String(op.amount)} for ${ref}, the ledger has no journal`)
    else if (journal.journals !== 1 || journal.gross !== op.amount) {
      found.push(`the PSP ${DID[attempt.kind]} ${String(op.amount)} for ${ref}, the ledger has ${journal.journals} journals for ${journal.gross}`)
    }
  }
  for (const [ref, journal] of money) {
    if ((ref.startsWith('capture:') || ref.startsWith('refund:')) && !succeeded.has(ref)) {
      found.push(`${ref} has ${journal.journals} journals for ${journal.gross}, the PSP did no such operation`)
    }
  }
  return { count: found.length, examples: found.slice(0, EXAMPLES) }
}

export async function checkAgainstPsp(ledger: pg.Pool, psp: Queryable): Promise<InvariantResult> {
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
