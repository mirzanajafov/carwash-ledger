import { randomUUID } from 'node:crypto'
import {
  checkAgainstPsp,
  checkEvents,
  checkEventsIn,
  checkLedger,
  checkPayments,
  checkPaymentsIn,
  checkPaymentsIncrementally,
  checkSettled,
  checkSettledIn,
  checkSettlementIn,
  violations,
  type InvariantId,
  type InvariantResult,
  type PaymentBase,
} from '@carwash/invariants'
import { firstRow, inSnapshot } from '@carwash/pg'
import { NO_FAULTS } from '@carwash/psp'
import type pg from 'pg'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { Database } from '../src/db/database.ts'
import { count, deliver, outboxEvents, startStack, type Stack } from './support.ts'

let stack: Stack
let settledDay: number
let base: PaymentBase
const payments: Record<'auto' | 'manual' | 'authorized' | 'declined', string> = {} as never

function pay(token: string, extra: Record<string, unknown> = {}) {
  return { amount: 1500, currency: 'EUR', merchant: 'wash_1', token, ...extra }
}

async function attemptOf(paymentId: string, kind: string): Promise<string> {
  return firstRow(
    await stack.admin.query<{ id: string }>('SELECT id FROM attempts WHERE payment_id = $1 AND kind = $2::attempt_kind ORDER BY created_at DESC LIMIT 1', [
      paymentId,
      kind,
    ]),
  ).id
}

async function accountId(code: string): Promise<string> {
  return firstRow(await stack.admin.query<{ id: string }>('SELECT id::text FROM accounts WHERE code = $1', [code])).id
}

function counts(results: readonly InvariantResult[]): Partial<Record<InvariantId, number>> {
  return Object.fromEntries(results.map((r) => [r.id, r.count]))
}

async function corrupted(
  pool: pg.Pool,
  corrupt: (client: pg.PoolClient) => Promise<unknown>,
  check: (client: pg.PoolClient) => Promise<InvariantResult[]>,
): Promise<Partial<Record<InvariantId, number>>> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    await corrupt(client)
    return counts(await check(client))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

function inLedger(corrupt: (client: pg.PoolClient) => Promise<unknown>, since?: PaymentBase) {
  return corrupted(stack.admin, corrupt, async (client) => [...(await checkPaymentsIn(client, { since })).results, await checkSettledIn(client)])
}

function inEvents(corrupt: (client: pg.PoolClient) => Promise<unknown>) {
  return corrupted(stack.admin, corrupt, checkEventsIn)
}

function inSettlement(corrupt: (client: pg.PoolClient) => Promise<unknown>) {
  return corrupted(stack.admin, corrupt, async (client) => [
    await checkSettlementIn(client, { daySeconds: 86_400, feeBps: 120, feeFixed: 8, completeThrough: settledDay }),
  ])
}

async function settlementExamples(corrupt: (client: pg.PoolClient) => Promise<unknown>): Promise<string[]> {
  const client = await stack.admin.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    await corrupt(client)
    return (await checkSettlementIn(client, { daySeconds: 86_400, feeBps: 120, feeFixed: 8, completeThrough: settledDay })).examples
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

function atPsp(corrupt: (client: pg.PoolClient) => Promise<unknown>) {
  return corrupted(stack.pspSql, corrupt, async (client) => [await checkAgainstPsp(stack.admin, client)])
}

const corruptions = {
  'a second capture journal': async (client) => {
    await client.query('DROP INDEX journals_external_ref_key')
    const { rows } = await client.query<{ account_id: string; amount: number }>(
      `SELECT e.account_id::text, e.amount::int FROM entries e JOIN journals j ON j.id = e.journal_id WHERE j.external_ref = $1`,
      [`capture:${payments.auto}`],
    )
    await postJournal(
      client,
      `capture:${payments.auto}`,
      rows.map((r) => [r.account_id, r.amount]),
    )
  },
  'a payment captured without its journal': (client) =>
    client.query(`UPDATE payments SET status = 'captured', captured_amount = amount WHERE id = $1`, [payments.authorized]),
  'a refund beyond the capture': async (client) => {
    const { id } = firstRow(
      await client.query<{ id: string }>(`INSERT INTO refunds (payment_id, amount, status) VALUES ($1, 1000, 'succeeded') RETURNING id`, [payments.manual]),
    )
    await postJournal(client, `refund:${id}`, [
      [await accountId('psp_receivable:EUR'), -1000],
      [await accountId('merchant_payable:wash_1'), 1000],
    ])
  },
  'a payment no key created': (client) => client.query(`DELETE FROM idempotency_keys WHERE payment_id = $1 AND path = '/v1/payments'`, [payments.auto]),
  'a payment two keys created': (client) =>
    client.query(
      `INSERT INTO idempotency_keys (client_id, key, method, path, request_hash, state, payment_id)
       SELECT client_id, key || '-again', method, path, request_hash, state, payment_id
       FROM idempotency_keys WHERE payment_id = $1 AND path = '/v1/payments'`,
      [payments.manual],
    ),
  'a debit committed behind a payout': async (client) =>
    postJournal(
      client,
      'debit-that-took-an-early-id',
      [
        [await accountId('merchant_payable:wash_1'), 100],
        [await accountId('psp_receivable:EUR'), -100],
      ],
      -1,
    ),
} satisfies Record<string, (client: pg.PoolClient) => Promise<unknown>>

async function postJournal(client: pg.ClientBase, ref: string, entries: [string, number][], id?: number): Promise<string> {
  const { id: journalId } = firstRow(
    await client.query<{ id: string }>(`INSERT INTO journals (id, external_ref) VALUES (coalesce($1, nextval('journals_id_seq')), $2) RETURNING id::text`, [
      id ?? null,
      ref,
    ]),
  )
  for (const [account, amount] of entries) {
    await client.query('INSERT INTO entries (journal_id, account_id, amount, currency) SELECT $1, id, $3, currency FROM accounts WHERE id = $2', [
      journalId,
      account,
      amount,
    ])
  }
  return journalId
}

beforeAll(async () => {
  stack = await startStack()
  const call = stack.call
  payments.auto = (await call('POST', '/v1/payments', { body: pay('tok_ok') })).body.id
  payments.manual = (await call('POST', '/v1/payments', { body: pay('tok_ok', { capture: 'manual' }) })).body.id
  await call('POST', `/v1/payments/${payments.manual}/capture`, { body: { amount: 1200 } })
  await call('POST', `/v1/payments/${payments.manual}/refunds`, { body: { amount: 500 } })
  payments.authorized = (await call('POST', '/v1/payments', { body: pay('tok_ok', { capture: 'manual' }) })).body.id
  payments.declined = (await call('POST', '/v1/payments', { body: pay('tok_decline') })).body.payment.id
  expect((await call('POST', '/v1/payments', { body: pay('tok_wrong_amount_capture') })).status).toBe(502)
  await call('POST', '/v1/payments', { body: pay('tok_ok', { merchant: 'wash_2', amount: 3000 }) })
  expect((await call('POST', '/v1/payouts', { as: 'admin', body: { merchant: 'wash_1', currency: 'EUR' } })).body.status).toBe('succeeded')
  stack.psp.faults.plan = { ...NO_FAULTS, decline: 1 }
  expect((await call('POST', '/v1/payouts', { as: 'admin', body: { merchant: 'wash_2', currency: 'EUR' } })).body.status).toBe('failed')
  stack.psp.faults.plan = NO_FAULTS
  settledDay = stack.psp.settlements.calendar().current_day
  await stack.psp.settlements.close(settledDay)
  expect((await call('POST', `/v1/settlements/${settledDay}/ingest`, { as: 'admin' })).body.outcome).toBe('ingested')
  const app = stack.app.get(Database).pool
  await deliver(app, [await outboxEvents(app)])
  const clean = await inSnapshot(stack.admin, (client) => checkPaymentsIn(client))
  assert(clean.base)
  base = clean.base
})

afterAll(async () => {
  await stack.close()
})

describe('the payment invariants', () => {
  it('find nothing wrong after payments, refunds, payouts, a decline and a refused PSP answer', async () => {
    expect(violations(await checkLedger(stack.admin))).toEqual([])
    expect(violations(await checkPayments(stack.admin))).toEqual([])
    expect(violations([await checkAgainstPsp(stack.admin, stack.pspSql), await checkSettled(stack.admin)])).toEqual([])
    expect(await inLedger(async () => undefined)).toEqual({ S3: 0, S5: 0, S6: 0, L1: 0 })
  })

  it('catch a second capture journal, a state without its journal, and refunds beyond the capture (S3)', async () => {
    expect(await inLedger(corruptions['a second capture journal'])).toMatchObject({ S3: 2, S5: 0, S6: 0 })
    expect(await inLedger(corruptions['a payment captured without its journal'])).toMatchObject({ S3: 1 })
    expect(await inLedger(corruptions['a refund beyond the capture'])).toMatchObject({ S3: 1 })
  })

  it('catch a payment that no key created, or that two keys did (S5)', async () => {
    expect(await inLedger(corruptions['a payment no key created'])).toMatchObject({ S3: 0, S5: 1 })
    expect(await inLedger(corruptions['a payment two keys created'])).toMatchObject({ S5: 1 })
  })

  it('catch a payout that the payable did not cover in journal order (S6)', async () => {
    expect(await inLedger(corruptions['a debit committed behind a payout'])).toMatchObject({ S3: 0, S5: 0, S6: 1 })
  })

  it.each(Object.entries(corruptions))('find %s just as well when they continue from a clean run taken before it', async (_, corrupt) => {
    expect(await inLedger(corrupt, base)).toEqual(await inLedger(corrupt))
  })

  it('catch an attempt that nothing will resolve (L1)', async () => {
    const stuck = await inLedger((client) =>
      client.query(`INSERT INTO attempts (kind, payment_id, amount, currency) VALUES ('capture', $1, 1500, 'EUR')`, [payments.declined]),
    )
    expect(stuck).toMatchObject({ L1: 1 })
  })

  it('catch the PSP and the ledger disagreeing about amounts, operations and outcomes (S4)', async () => {
    const capture = await attemptOf(payments.auto, 'capture')
    const refund = await attemptOf(payments.manual, 'refund')
    const { rows: payouts } = await stack.admin.query<{ id: string; status: string }>(
      `SELECT a.id, p.status::text FROM attempts a JOIN payouts p ON p.id = a.payout_id ORDER BY a.created_at`,
    )
    expect(payouts.map((p) => p.status)).toEqual(['succeeded', 'failed'])
    const [succeeded] = payouts
    assert(succeeded)
    expect(await atPsp((psp) => psp.query('UPDATE operations SET amount = amount + 1 WHERE idempotency_key = $1', [capture]))).toEqual({
      S4: 1,
    })
    expect(await atPsp((psp) => psp.query('DELETE FROM operations WHERE idempotency_key = $1', [refund]))).toEqual({ S4: 2 })
    expect(
      await atPsp((psp) =>
        psp.query(`INSERT INTO operations (id, idempotency_key, kind, status, amount, currency) VALUES ($1, $2, 'capture', 'succeeded', 1500, 'EUR')`, [
          `op_${randomUUID()}`,
          randomUUID(),
        ]),
      ),
    ).toEqual({ S4: 1 })
    expect(await atPsp((psp) => psp.query(`UPDATE operations SET status = 'declined' WHERE idempotency_key = $1`, [succeeded.id]))).toEqual({ S4: 2 })
    expect(await atPsp(async () => undefined)).toEqual({ S4: 0 })
  })
})

describe('the event invariants', () => {
  it('find nothing wrong once every event reached its consumers', async () => {
    expect(violations(await checkEvents(stack.admin))).toEqual([])
    expect(await inEvents(async () => undefined)).toEqual({ L2: 0, L3: 0 })
  })

  it('catch an event left in the outbox and one a consumer never got (L2)', async () => {
    expect(await inEvents((client) => client.query('UPDATE outbox SET published_at = NULL WHERE id = (SELECT max(id) FROM outbox)'))).toEqual({
      L2: 1,
      L3: 0,
    })
    expect(
      await inEvents((client) =>
        client.query(`DELETE FROM inbox WHERE consumer = 'statements' AND event_id = (SELECT event_id FROM outbox WHERE topic = 'ledger' LIMIT 1)`),
      ),
    ).toEqual({ L2: 1, L3: 0 })
  })

  it('catch a second receipt, a missing one, a gap in the numbers, a receipt for nothing, and a statement off by a cent (L3)', async () => {
    const issue = (paymentId: string) => (client: pg.PoolClient) =>
      client.query(
        `WITH counter AS (UPDATE receipt_counters SET last_number = last_number + 1 WHERE merchant = 'wash_1' RETURNING last_number)
         INSERT INTO receipts (merchant, number, payment_id, amount, fee, currency, captured_at, event_id)
         SELECT 'wash_1', last_number, $1, 1500, 40, 'EUR', now(), gen_random_uuid() FROM counter`,
        [paymentId],
      )
    expect(await inEvents(issue(payments.auto))).toEqual({ L2: 0, L3: 1 })
    expect(await inEvents(issue(payments.authorized))).toEqual({ L2: 0, L3: 1 })
    expect(
      await inEvents(async (client) => {
        await client.query(`DELETE FROM receipts WHERE payment_id = $1`, [payments.manual])
        await client.query(`UPDATE receipt_counters SET last_number = last_number - 1 WHERE merchant = 'wash_1'`)
      }),
    ).toEqual({ L2: 0, L3: 1 })
    expect(await inEvents((client) => client.query(`UPDATE receipts SET number = number + 10 WHERE payment_id = $1`, [payments.manual]))).toEqual({
      L2: 0,
      L3: 1,
    })
    expect(await inEvents((client) => client.query('UPDATE statements SET credits = credits + 1 WHERE ctid = (SELECT ctid FROM statements LIMIT 1)'))).toEqual({
      L2: 0,
      L3: 1,
    })
    expect(await inEvents(async () => undefined)).toEqual({ L2: 0, L3: 0 })
  })
})

describe('the settlement invariant', () => {
  const lineOf = async (paymentId: string) => {
    const capture = await attemptOf(paymentId, 'capture')
    return firstRow(await stack.admin.query<{ file_id: string; line: number }>('SELECT file_id, line FROM settlement_lines WHERE reference = $1', [capture]))
  }

  it('finds nothing wrong in a settled day, a refused PSP answer included', async () => {
    expect(await inSettlement(async () => undefined)).toEqual({ L5: 0 })
  })

  it('catches a lost line, a changed amount, a line counted twice, a line for nothing and a journal that disagrees (L5)', async () => {
    const auto = await lineOf(payments.auto)
    const lost = await settlementExamples((c) => c.query('DELETE FROM settlement_lines WHERE file_id = $1 AND line = $2', [auto.file_id, auto.line]))
    expect(lost).toHaveLength(2)
    expect(lost[1]).toContain('is in no file')
    const changed = await settlementExamples((c) =>
      c.query('UPDATE settlement_lines SET gross = gross + 1, net = net + 1 WHERE file_id = $1 AND line = $2', [auto.file_id, auto.line]),
    )
    expect(changed).toHaveLength(2)
    expect(changed[1]).toContain("disagrees with the ledger's 1500")
    const twice = await settlementExamples((c) =>
      c.query(
        `INSERT INTO settlement_lines (file_id, line, operation, reference, kind, gross, fee, net, operated_at)
         SELECT file_id, 1000, operation, reference, kind, gross, fee, net, operated_at FROM settlement_lines WHERE file_id = $1 AND line = $2`,
        [auto.file_id, auto.line],
      ),
    )
    expect(twice).toHaveLength(2)
    expect(twice[1]).toContain('is settled 2 times')
    const stranger = await settlementExamples((c) =>
      c.query('UPDATE settlement_lines SET reference = gen_random_uuid()::text WHERE file_id = $1 AND line = $2', [auto.file_id, auto.line]),
    )
    expect(stranger).toHaveLength(2)
    expect(stranger[0]).toContain('has no attempt')
    const journal = await settlementExamples((c) => c.query('UPDATE settlement_files SET net = net - 1, fee = fee + 1 WHERE id = $1', [auto.file_id]))
    expect(journal).toHaveLength(1)
    expect(journal[0]).toContain('Its journal moved')
    expect(await inSettlement(async () => undefined)).toEqual({ L5: 0 })
  })
})

describe('the payment invariants, continued from the last clean run', () => {
  it('check every payment the first time, then only what changed, and keep their place while something is broken', async () => {
    const audit = stack.ledgerDb.pool('ledger_audit', 2)
    const total = await count(stack.admin, 'SELECT count(*)::int AS n FROM payments')
    const first = await checkPaymentsIncrementally(audit)
    expect(first).toMatchObject({ since: undefined, payments: total })
    const quiet = await checkPaymentsIncrementally(audit)
    expect(quiet).toMatchObject({ payments: 0, entries: 0 })
    expect(quiet.since?.snapshot).toBe(first.base?.snapshot)

    const paid = (await stack.call('POST', '/v1/payments', { body: pay('tok_ok', { merchant: 'wash_2' }) })).body.id
    const next = await checkPaymentsIncrementally(audit)
    expect(next).toMatchObject({ payments: 1, entries: 1 })
    await stack.admin.query('UPDATE payments SET captured_amount = captured_amount - 1 WHERE id = $1', [paid])
    const broken = await checkPaymentsIncrementally(audit)
    expect(counts(broken.results)).toEqual({ S3: 1, S5: 0, S6: 0 })
    expect(broken.base).toBeUndefined()
    const again = await checkPaymentsIncrementally(audit)
    expect(again.since?.snapshot).toBe(next.base?.snapshot)
    expect(counts(again.results)).toEqual({ S3: 1, S5: 0, S6: 0 })
    await stack.admin.query('UPDATE payments SET captured_amount = captured_amount + 1 WHERE id = $1', [paid])
    expect(violations((await checkPaymentsIncrementally(audit)).results)).toEqual([])
  })

  it('start from the first payment when the saved place is ahead of the database, as after a restore into a new cluster', async () => {
    const audit = stack.ledgerDb.pool('ledger_audit', 2)
    await stack.admin.query(`UPDATE invariant_cursors SET snapshot = '4000000000:4000000000:' WHERE name = 'payments'`)
    const restored = await checkPaymentsIncrementally(audit)
    expect(restored.since).toBeUndefined()
    expect((await checkPaymentsIncrementally(audit)).since?.snapshot).toBe(restored.base?.snapshot)
  })

  it('see a payment changed by a transaction that was still open when the clean run took its snapshot', async () => {
    const audit = stack.ledgerDb.pool('ledger_audit', 2)
    const open = await stack.admin.connect()
    try {
      await open.query('BEGIN')
      await open.query('UPDATE payments SET captured_amount = captured_amount - 1 WHERE id = $1', [payments.auto])
      const clean = await inSnapshot(audit, (client) => checkPaymentsIn(client))
      expect(clean.base).toBeDefined()
      await open.query('COMMIT')
      const resumed = await inSnapshot(audit, (client) => checkPaymentsIn(client, { since: clean.base }))
      expect(counts(resumed.results)).toEqual({ S3: 1, S5: 0, S6: 0 })
    } finally {
      open.release()
    }
    await stack.admin.query('UPDATE payments SET captured_amount = captured_amount + 1 WHERE id = $1', [payments.auto])
  })

  it('replay a merchant from the start when a debit that was open at the clean run commits behind a payout', async () => {
    const audit = stack.ledgerDb.pool('ledger_audit', 2)
    const merchant = await accountId('merchant_payable:wash_1')
    const receivable = await accountId('psp_receivable:EUR')
    const bank = await accountId('bank:EUR')
    expect((await stack.call('POST', '/v1/payments', { body: pay('tok_ok') })).body.status).toBe('captured')
    const open = await stack.admin.connect()
    const payout = await stack.admin.connect()
    try {
      await open.query('BEGIN')
      await postJournal(open, 'debit-open-at-the-clean-run', [
        [merchant, 100],
        [receivable, -100],
      ])
      await payout.query('BEGIN')
      const { payable } = firstRow(
        await payout.query<{ payable: number }>('SELECT (-sum(amount))::int AS payable FROM entries WHERE account_id = $1', [merchant]),
      )
      await postJournal(payout, `payout:${randomUUID()}`, [
        [merchant, payable],
        [bank, -payable],
      ])
      await payout.query('COMMIT')
      const clean = await inSnapshot(audit, (client) => checkPaymentsIn(client))
      expect(counts(clean.results)).toEqual({ S3: 0, S5: 0, S6: 0 })
      await open.query('COMMIT')
      const resumed = await inSnapshot(audit, (client) => checkPaymentsIn(client, { since: clean.base }))
      expect(counts(resumed.results)).toEqual({ S3: 0, S5: 0, S6: 1 })
      expect(resumed.results).toEqual((await inSnapshot(audit, (client) => checkPaymentsIn(client))).results)
    } finally {
      open.release()
      payout.release()
    }
  })
})
