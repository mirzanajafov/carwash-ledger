import type pg from 'pg'
import type { RequestRecord } from './client.ts'
import type { PaymentBelief, PayoutBelief } from './journeys.ts'

export interface Finding {
  count: number
  examples: string[]
}

const EXAMPLES = 5

function finding(found: readonly string[]): Finding {
  return { count: found.length, examples: found.slice(0, EXAMPLES) }
}

export function checkKeys(records: Iterable<RequestRecord>, probes: Iterable<RequestRecord>): Finding {
  const found: string[] = []
  for (const record of records) {
    const distinct = [...new Set(record.stored)]
    if (distinct.length > 1) found.push(`key ${record.key} (${record.kind}) was answered ${distinct.length} different ways: ${distinct.join(' | ').slice(0, 400)}`)
  }
  for (const probe of probes) {
    const final = probe.final
    if (final === undefined) continue
    if (final.status !== 422 || final.body?.error?.code !== 'idempotency_key_reused') {
      found.push(`key ${probe.key} reused for another ${probe.kind} body got ${final.status} ${JSON.stringify(final.body).slice(0, 200)}`)
    }
  }
  return finding(found)
}

export function unanswered(records: Iterable<RequestRecord>, probes: Iterable<RequestRecord>): Finding {
  const found: string[] = []
  for (const record of [...records, ...probes]) {
    if (record.final !== undefined) continue
    found.push(`${record.kind} ${record.path} with ${record.key} has no answer after ${record.sends} sends (${record.lastError ?? 'nothing yet'})`)
  }
  return finding(found)
}

export interface LedgerState {
  payments: Map<string, { status: string; captured: number; refunded: number }>
  refunds: Map<string, { status: string; amount: number }>
  payouts: Map<string, { status: string; amount: number }>
  anomalous: Set<string>
}

export async function readState(pool: pg.Pool, refusedKeys: readonly string[]): Promise<LedgerState> {
  const payments = await pool.query<{ id: string; status: string; captured: string; refunded: string }>(
    'SELECT id::text, status::text, captured_amount::text AS captured, refunded_amount::text AS refunded FROM payments',
  )
  const refunds = await pool.query<{ id: string; status: string; amount: string }>('SELECT id::text, status::text, amount::text FROM refunds')
  const payouts = await pool.query<{ id: string; status: string; amount: string }>('SELECT id::text, status::text, amount::text FROM payouts')
  const anomalous = await pool.query<{ key: string }>(
    `SELECT k.key FROM idempotency_keys k
     WHERE k.key = ANY($1::text[]) AND EXISTS (
       SELECT 1 FROM attempts a JOIN anomalies n ON n.attempt_id = a.id
       WHERE CASE WHEN k.refund_id IS NOT NULL THEN a.refund_id = k.refund_id
                  WHEN k.payout_id IS NOT NULL THEN a.payout_id = k.payout_id
                  ELSE a.payment_id = k.payment_id END)`,
    [refusedKeys],
  )
  return {
    payments: new Map(payments.rows.map((r) => [r.id, { status: r.status, captured: Number(r.captured), refunded: Number(r.refunded) }])),
    refunds: new Map(refunds.rows.map((r) => [r.id, { status: r.status, amount: Number(r.amount) }])),
    payouts: new Map(payouts.rows.map((r) => [r.id, { status: r.status, amount: Number(r.amount) }])),
    anomalous: new Set(anomalous.rows.map((r) => r.key)),
  }
}

export function compareBeliefs(
  payments: readonly PaymentBelief[],
  payouts: readonly PayoutBelief[],
  refused: readonly RequestRecord[],
  state: LedgerState,
): Finding {
  const found: string[] = []
  for (const belief of payments) {
    const row = state.payments.get(belief.paymentId)
    if (row === undefined) {
      found.push(`payment ${belief.paymentId} was answered to a client but is not in the ledger`)
      continue
    }
    if (row.status !== belief.status || row.captured !== belief.captured || row.refunded !== belief.refunded) {
      found.push(
        `payment ${belief.paymentId}: the client was told ${belief.status} with ${belief.captured} captured and ${belief.refunded} refunded, ` +
          `the ledger has ${row.status} with ${row.captured} and ${row.refunded}`,
      )
    }
    for (const refund of belief.refunds) {
      const stored = state.refunds.get(refund.id)
      if (stored?.status !== 'succeeded' || stored.amount !== refund.amount) {
        found.push(`refund ${refund.id} of ${refund.amount} was told succeeded, the ledger has it ${stored?.status ?? 'missing'} for ${stored?.amount}`)
      }
    }
  }
  for (const belief of payouts) {
    const row = state.payouts.get(belief.payoutId)
    if (row?.status !== belief.status || row.amount !== belief.amount) {
      found.push(`payout ${belief.payoutId} was told ${belief.status} for ${belief.amount}, the ledger has ${row?.status ?? 'nothing'} for ${row?.amount}`)
    }
  }
  for (const request of refused) {
    if (!state.anomalous.has(request.key)) found.push(`${request.kind} with ${request.key} was refused with a 502, but no anomaly was recorded`)
  }
  return finding(found)
}
