import { checkAgainstPsp, checkLedger, checkPayments, violations } from '@carwash/invariants'
import { NO_FAULTS } from '@carwash/psp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { count, startStack, type Stack } from './support.ts'

let stack: Stack

function pay(token: string, extra: Record<string, unknown> = {}) {
  return { amount: 1500, currency: 'EUR', merchant: 'wash_1', token, ...extra }
}

async function openAnomalies() {
  return (await stack.call('GET', '/v1/admin/anomalies', { as: 'admin' })).body.data as any[]
}

async function clean() {
  expect(violations(await checkLedger(stack.admin))).toEqual([])
  expect(violations(await checkPayments(stack.admin))).toEqual([])
  expect(violations([await checkAgainstPsp(stack.admin, stack.pspSql)])).toEqual([])
}

beforeAll(async () => {
  stack = await startStack()
})

afterAll(async () => {
  await stack.close()
})

describe('resolving anomalies', () => {
  it('accepts the amount the bank captured, and the books agree with the bank again', async () => {
    const refused = await stack.call('POST', '/v1/payments', { body: pay('tok_wrong_amount_capture') })
    expect(refused.status).toBe(502)
    const [anomaly] = (await openAnomalies()).filter((a) => a.attempt?.kind === 'capture')
    expect(anomaly).toMatchObject({ kind: 'answer_mismatch', acceptable: true, bank_amount: '1499', attempt: { amount: '1500', status: 'pending' } })
    expect((await stack.call('GET', '/v1/admin/anomalies')).status).toBe(403)
    expect((await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { key: null })).status).toBe(403)

    const accepted = await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { as: 'admin', key: null })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ resolution: 'accepted', resolved_by: 'admin', acceptable: false, attempt: { amount: '1499', status: 'succeeded' } })
    const payment = await stack.call('GET', `/v1/payments/${anomaly.payment_id}`)
    expect(payment.body).toMatchObject({ status: 'captured', captured_amount: 1499 })
    expect((await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { as: 'admin', key: null })).status).toBe(409)
    expect((await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/dispute`, { as: 'admin', key: null })).status).toBe(409)
    await clean()
  })

  it('accepts a refund the bank made for less than was asked', async () => {
    const paid = await stack.call('POST', '/v1/payments', { body: pay('tok_wrong_amount_refund') })
    expect(paid.body.status).toBe('captured')
    expect((await stack.call('POST', `/v1/payments/${paid.body.id}/refunds`, { body: { amount: 500 } })).status).toBe(502)
    const [anomaly] = (await openAnomalies()).filter((a) => a.attempt?.kind === 'refund')
    expect(anomaly).toMatchObject({ acceptable: true, bank_amount: '499' })
    expect((await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { as: 'admin', key: null })).body.resolution).toBe('accepted')
    expect((await stack.call('GET', `/v1/payments/${paid.body.id}`)).body).toMatchObject({ status: 'captured', refunded_amount: 499 })
    const refund = await stack.admin.query('SELECT amount::int, status::text FROM refunds WHERE id = $1', [anomaly.refund_id])
    expect(refund.rows[0]).toEqual({ amount: 499, status: 'succeeded' })
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
    const [anomaly] = (await openAnomalies()).filter((a) => a.attempt?.kind === 'payout')
    expect(anomaly).toMatchObject({ acceptable: true, merchant: 'wash_2' })
    const asked = Number(anomaly.attempt.amount)
    expect(Number(anomaly.bank_amount)).toBe(asked - 1)
    const accepted = await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { as: 'admin', key: null })
    expect(accepted.body).toMatchObject({ resolution: 'accepted', attempt: { amount: String(asked - 1), status: 'succeeded' } })
    const payout = await stack.admin.query(
      `SELECT po.amount::int, po.status::text, j.external_ref FROM payouts po JOIN journals j ON j.id = po.adjustment_journal_id WHERE po.id = $1`,
      [anomaly.payout_id],
    )
    expect(payout.rows[0]).toEqual({ amount: asked - 1, status: 'succeeded', external_ref: `payout-adjustment:${anomaly.payout_id}` })
    const payable = await stack.admin.query<{ owed: string }>(
      `SELECT (-sum(b.amount))::text AS owed FROM balances b JOIN merchants m ON m.account_id = b.account_id WHERE m.code = 'wash_2'`,
    )
    expect(payable.rows).toEqual([{ owed: '1' }])
    await clean()
  })

  it('disputes without moving any money', async () => {
    expect((await stack.call('POST', '/v1/payments', { body: pay('tok_wrong_amount_capture') })).status).toBe(502)
    const [anomaly] = (await openAnomalies()).filter((a) => a.attempt?.kind === 'capture')
    const journals = await count(stack.admin, 'SELECT count(*)::int AS n FROM journals')
    const disputed = await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/dispute`, { as: 'admin', key: null })
    expect(disputed.body).toMatchObject({ resolution: 'disputed', attempt: { status: 'pending' } })
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM journals')).toBe(journals)
    expect((await openAnomalies()).find((a) => a.id === anomaly.id)).toBeUndefined()
    expect((await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { as: 'admin', key: null })).status).toBe(409)
    const resolved = (await stack.call('GET', '/v1/admin/anomalies?state=resolved', { as: 'admin' })).body.data as any[]
    expect(resolved.map((a) => a.resolution).sort()).toEqual(['accepted', 'accepted', 'accepted', 'disputed'])
  })
})
