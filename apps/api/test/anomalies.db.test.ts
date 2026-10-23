import { AnomalyList, AnomalyView, PaymentView } from '@carwash/contracts'
import { checkAgainstPsp, checkLedger, checkPayments, violations } from '@carwash/invariants'
import { NO_FAULTS } from '@carwash/psp'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { count, startStack, type Stack } from './support.ts'

let stack: Stack

function pay(token: string, extra: Record<string, unknown> = {}) {
  return { amount: 1500, currency: 'EUR', merchant: 'wash_1', token, ...extra }
}

async function anomalies(state: 'open' | 'resolved'): Promise<AnomalyView[]> {
  return AnomalyList.parse((await stack.call('GET', `/v1/admin/anomalies?state=${state}`, { as: 'admin' })).body).data
}

async function openAnomaly(kind: 'capture' | 'refund' | 'payout'): Promise<AnomalyView> {
  const found = (await anomalies('open')).find((a) => a.attempt?.kind === kind)
  assert(found, `no open ${kind} anomaly`)
  return found
}

async function clean() {
  expect(violations(await checkLedger(stack.admin))).toEqual([])
  expect(violations(await checkPayments(stack.admin))).toEqual([])
  expect(violations([await checkAgainstPsp(stack.admin, stack.pspSql)])).toEqual([])
}

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  stack = await startStack()
  cleanup.defer(() => stack.close())
})

afterAll(() => cleanup.disposeAsync())

describe('resolving anomalies', () => {
  it('accepts the amount the bank captured, and the books agree with the bank again', async () => {
    const refused = await stack.call('POST', '/v1/payments', { body: pay('tok_wrong_amount_capture') })
    expect(refused.status).toBe(502)
    const anomaly = await openAnomaly('capture')
    expect(anomaly).toMatchObject({ kind: 'answer_mismatch', acceptable: true, bank_amount: '1499', attempt: { amount: '1500', status: 'pending' } })
    expect((await stack.call('GET', '/v1/admin/anomalies')).status).toBe(403)
    expect((await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { key: null })).status).toBe(403)

    const accepted = await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { as: 'admin', key: null })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ resolution: 'accepted', resolved_by: 'admin', acceptable: false, attempt: { amount: '1499', status: 'succeeded' } })
    assert(anomaly.payment_id)
    const payment = await stack.call('GET', `/v1/payments/${anomaly.payment_id}`)
    expect(payment.body).toMatchObject({ status: 'captured', captured_amount: 1499 })
    expect((await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { as: 'admin', key: null })).status).toBe(409)
    expect((await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/dispute`, { as: 'admin', key: null })).status).toBe(409)
    await clean()
  })

  it('accepts a refund the bank made for less than was asked', async () => {
    const paid = PaymentView.parse((await stack.call('POST', '/v1/payments', { body: pay('tok_wrong_amount_refund') })).body)
    expect(paid.status).toBe('captured')
    expect((await stack.call('POST', `/v1/payments/${paid.id}/refunds`, { body: { amount: 500 } })).status).toBe(502)
    const anomaly = await openAnomaly('refund')
    expect(anomaly).toMatchObject({ acceptable: true, bank_amount: '499' })
    expect((await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { as: 'admin', key: null })).body).toMatchObject({ resolution: 'accepted' })
    expect((await stack.call('GET', `/v1/payments/${paid.id}`)).body).toMatchObject({ status: 'captured', refunded_amount: 499 })
    const refund = await stack.admin.query<{ amount: number; status: string }>('SELECT amount::int, status::text FROM refunds WHERE id = $1', [
      anomaly.refund_id,
    ])
    expect(refund.rows).toEqual([{ amount: 499, status: 'succeeded' }])
    await clean()
  })

  it('accepts a payout the bank made for less, and gives the difference back to the merchant', async () => {
    await stack.call('POST', '/v1/payments', { body: pay('tok_ok', { merchant: 'wash_2' }) })
    stack.psp.faults.plan = { ...NO_FAULTS, wrongAmount: 1 }
    try {
      expect((await stack.call('POST', '/v1/payouts', { as: 'admin', body: { merchant: 'wash_2', currency: 'EUR' } })).status).toBe(502)
    } finally {
      stack.psp.faults.plan = NO_FAULTS
    }
    const anomaly = await openAnomaly('payout')
    expect(anomaly).toMatchObject({ acceptable: true, merchant: 'wash_2' })
    assert(anomaly.attempt)
    const asked = Number(anomaly.attempt.amount)
    expect(Number(anomaly.bank_amount)).toBe(asked - 1)
    const accepted = await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { as: 'admin', key: null })
    expect(accepted.body).toMatchObject({ resolution: 'accepted', attempt: { amount: String(asked - 1), status: 'succeeded' } })
    const payout = await stack.admin.query<{ amount: number; status: string; external_ref: string }>(
      `SELECT po.amount::int, po.status::text, j.external_ref FROM payouts po JOIN journals j ON j.id = po.adjustment_journal_id WHERE po.id = $1`,
      [anomaly.payout_id],
    )
    expect(payout.rows).toEqual([{ amount: asked - 1, status: 'succeeded', external_ref: `payout-adjustment:${String(anomaly.payout_id)}` }])
    const payable = await stack.admin.query<{ owed: string }>(
      `SELECT (-sum(b.amount))::text AS owed FROM balances b JOIN merchants m ON m.account_id = b.account_id WHERE m.code = 'wash_2'`,
    )
    expect(payable.rows).toEqual([{ owed: '1' }])
    await clean()
  })

  it('disputes without moving any money', async () => {
    expect((await stack.call('POST', '/v1/payments', { body: pay('tok_wrong_amount_capture') })).status).toBe(502)
    const anomaly = await openAnomaly('capture')
    const journals = await count(stack.admin, 'SELECT count(*)::int AS n FROM journals')
    const disputed = await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/dispute`, { as: 'admin', key: null })
    expect(disputed.body).toMatchObject({ resolution: 'disputed', attempt: { status: 'pending' } })
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM journals')).toBe(journals)
    expect((await anomalies('open')).find((a) => a.id === anomaly.id)).toBeUndefined()
    expect((await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { as: 'admin', key: null })).status).toBe(409)
    const resolved = await anomalies('resolved')
    expect(resolved.map((a) => a.resolution).sort()).toEqual(['accepted', 'accepted', 'accepted', 'disputed'])
  })

  it('lists open or resolved anomalies, and refuses any other state or a limit out of range', async () => {
    const refused = async (path: string) => (await stack.call('GET', path, { as: 'admin' })).body
    const message = (text: string) => ({ error: { code: 'invalid_request', message: text } })
    expect(await refused('/v1/admin/anomalies?state=all')).toEqual(message('state must be open or resolved'))
    expect(await refused('/v1/admin/anomalies?limit=500')).toEqual(message('limit must be between 1 and 200'))
    expect(AnomalyList.parse((await stack.call('GET', '/v1/admin/anomalies?state=resolved&limit=2', { as: 'admin' })).body).data.length).toBeLessThanOrEqual(2)
  })
})
