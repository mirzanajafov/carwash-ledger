import { checkAgainstPsp, checkLedger, checkPayments, violations } from '@carwash/invariants'
import { NO_FAULTS } from '@carwash/psp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startStack, type Stack } from './support.ts'

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
  await stack?.close()
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

  it('lets a payout only be disputed, and a dispute moves no money', async () => {
    await stack.call('POST', '/v1/payments', { body: pay('tok_ok', { merchant: 'wash_2' }) })
    stack.psp.faults.plan = { ...NO_FAULTS, wrongAmount: 1 }
    try {
      expect((await stack.call('POST', '/v1/payouts', { as: 'admin', body: { merchant: 'wash_2', currency: 'EUR' } })).status).toBe(502)
    } finally {
      stack.psp.faults.plan = NO_FAULTS
    }
    const [anomaly] = (await openAnomalies()).filter((a) => a.attempt?.kind === 'payout')
    expect(anomaly).toMatchObject({ acceptable: false, merchant: 'wash_2' })
    expect((await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/accept`, { as: 'admin', key: null })).status).toBe(409)
    const journals = (await stack.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM journals')).rows[0]!.n
    const disputed = await stack.call('POST', `/v1/admin/anomalies/${anomaly.id}/dispute`, { as: 'admin', key: null })
    expect(disputed.body).toMatchObject({ resolution: 'disputed', attempt: { status: 'pending' } })
    expect((await stack.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM journals')).rows[0]!.n).toBe(journals)
    expect((await openAnomalies()).find((a) => a.id === anomaly.id)).toBeUndefined()
    const resolved = (await stack.call('GET', '/v1/admin/anomalies?state=resolved', { as: 'admin' })).body.data as any[]
    expect(resolved.map((a) => a.resolution).sort()).toEqual(['accepted', 'accepted', 'disputed'])
  })
})
