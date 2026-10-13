import { randomUUID } from 'node:crypto'
import {
  checkAgainstPsp,
  checkLedger,
  checkPayments,
  checkPaymentsIn,
  checkSettled,
  checkSettledIn,
  violations,
  type InvariantId,
  type InvariantResult,
} from '@carwash/invariants'
import { NO_FAULTS } from '@carwash/psp'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startStack, type Stack } from './support.ts'

let stack: Stack
const payments: Record<'auto' | 'manual' | 'authorized' | 'declined', string> = {} as never

function pay(token: string, extra: Record<string, unknown> = {}) {
  return { amount: 1500, currency: 'EUR', merchant: 'wash_1', token, ...extra }
}

async function attemptOf(paymentId: string, kind: string): Promise<string> {
  const { rows } = await stack.admin.query<{ id: string }>(
    'SELECT id FROM attempts WHERE payment_id = $1 AND kind = $2::attempt_kind ORDER BY created_at DESC LIMIT 1',
    [paymentId, kind],
  )
  return rows[0]!.id
}

async function accountId(code: string): Promise<string> {
  const { rows } = await stack.admin.query<{ id: string }>('SELECT id::text FROM accounts WHERE code = $1', [code])
  return rows[0]!.id
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

function inLedger(corrupt: (client: pg.PoolClient) => Promise<unknown>) {
  return corrupted(stack.admin, corrupt, async (client) => [...(await checkPaymentsIn(client)), await checkSettledIn(client)])
}

function atPsp(corrupt: (client: pg.PoolClient) => Promise<unknown>) {
  return corrupted(stack.pspSql, corrupt, async (client) => [await checkAgainstPsp(stack.admin, client)])
}

async function postJournal(client: pg.ClientBase, ref: string, entries: [string, number][], id?: number): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journals (id, external_ref) VALUES (coalesce($1, nextval('journals_id_seq')), $2) RETURNING id::text`,
    [id ?? null, ref],
  )
  for (const [account, amount] of entries) {
    await client.query('INSERT INTO entries (journal_id, account_id, amount) VALUES ($1, $2, $3)', [rows[0]!.id, account, amount])
  }
  return rows[0]!.id
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
})

afterAll(async () => {
  await stack?.close()
})

describe('the payment invariants', () => {
  it('find nothing wrong after payments, refunds, payouts, a decline and a refused PSP answer', async () => {
    expect(violations(await checkLedger(stack.admin))).toEqual([])
    expect(violations(await checkPayments(stack.admin))).toEqual([])
    expect(violations([await checkAgainstPsp(stack.admin, stack.pspSql), await checkSettled(stack.admin)])).toEqual([])
    expect(await inLedger(async () => undefined)).toEqual({ S3: 0, S5: 0, S6: 0, L1: 0 })
  })

  it('catch a second capture journal, a state without its journal, and refunds beyond the capture (S3)', async () => {
    const second = await inLedger(async (client) => {
      await client.query('DROP INDEX journals_external_ref_key')
      const { rows } = await client.query<{ account_id: string; amount: number }>(
        `SELECT e.account_id::text, e.amount::int FROM entries e JOIN journals j ON j.id = e.journal_id WHERE j.external_ref = $1`,
        [`capture:${payments.auto}`],
      )
      await postJournal(client, `capture:${payments.auto}`, rows.map((r) => [r.account_id, r.amount]))
    })
    expect(second).toMatchObject({ S3: 2, S5: 0, S6: 0 })
    const unbooked = await inLedger((client) =>
      client.query(`UPDATE payments SET status = 'captured', captured_amount = amount WHERE id = $1`, [payments.authorized]),
    )
    expect(unbooked).toMatchObject({ S3: 1 })
    const beyond = await inLedger(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO refunds (payment_id, amount, status) VALUES ($1, 1000, 'succeeded') RETURNING id`,
        [payments.manual],
      )
      await postJournal(client, `refund:${rows[0]!.id}`, [
        [await accountId('psp_receivable:EUR'), -1000],
        [await accountId('merchant_payable:wash_1'), 1000],
      ])
    })
    expect(beyond).toMatchObject({ S3: 1 })
  })

  it('catch a payment that no key created, or that two keys did (S5)', async () => {
    const orphan = await inLedger((client) =>
      client.query(`DELETE FROM idempotency_keys WHERE payment_id = $1 AND path = '/v1/payments'`, [payments.auto]),
    )
    expect(orphan).toMatchObject({ S3: 0, S5: 1 })
    const twice = await inLedger((client) =>
      client.query(
        `INSERT INTO idempotency_keys (client_id, key, method, path, request_hash, state, payment_id)
         SELECT client_id, key || '-again', method, path, request_hash, state, payment_id
         FROM idempotency_keys WHERE payment_id = $1 AND path = '/v1/payments'`,
        [payments.manual],
      ),
    )
    expect(twice).toMatchObject({ S5: 1 })
  })

  it('catch a payout that the payable did not cover in journal order (S6)', async () => {
    const reordered = await inLedger(async (client) => {
      await postJournal(
        client,
        'debit-that-took-an-early-id',
        [
          [await accountId('merchant_payable:wash_1'), 100],
          [await accountId('psp_receivable:EUR'), -100],
        ],
        -1,
      )
    })
    expect(reordered).toMatchObject({ S3: 0, S5: 0, S6: 1 })
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
    expect(await atPsp((psp) => psp.query('UPDATE operations SET amount = amount + 1 WHERE idempotency_key = $1', [capture]))).toEqual({
      S4: 1,
    })
    expect(await atPsp((psp) => psp.query('DELETE FROM operations WHERE idempotency_key = $1', [refund]))).toEqual({ S4: 2 })
    expect(
      await atPsp((psp) =>
        psp.query(
          `INSERT INTO operations (id, idempotency_key, kind, status, amount, currency) VALUES ($1, $2, 'capture', 'succeeded', 1500, 'EUR')`,
          [`op_${randomUUID()}`, randomUUID()],
        ),
      ),
    ).toEqual({ S4: 1 })
    expect(
      await atPsp((psp) => psp.query(`UPDATE operations SET status = 'declined' WHERE idempotency_key = $1`, [payouts[0]!.id])),
    ).toEqual({ S4: 2 })
    expect(await atPsp(async () => undefined)).toEqual({ S4: 0 })
  })
})
