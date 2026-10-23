import { BreakList, PaymentView, SettlementDayView, SettlementView } from '@carwash/contracts'
import { checkLedger, checkSettlement, violations } from '@carwash/invariants'
import { firstRow } from '@carwash/pg'
import { NO_FAULTS, SETTLEMENT_FAULTS, type SettlementFault } from '@carwash/psp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startStack, type Stack } from './support.ts'

let stack: Stack
let today: number

function pay(amount: number, extra: Record<string, unknown> = {}) {
  return { amount, currency: 'EUR', merchant: 'wash_1', token: 'tok_ok', ...extra }
}

async function ingest(day: number) {
  await stack.psp.settlements.close(day)
  const reply = await stack.call('POST', `/v1/settlements/${day}/ingest`, { as: 'admin' })
  expect(reply.status).toBe(201)
  return SettlementView.parse(reply.body)
}

async function breaksFor(paymentId: string): Promise<string[]> {
  const { rows } = await stack.admin.query<{ class: string }>('SELECT class FROM recon_breaks WHERE journal_ref = $1 ORDER BY class', [`capture:${paymentId}`])
  return rows.map((row) => row.class)
}

function only(fault: SettlementFault) {
  return { ...NO_FAULTS, settlement: Object.fromEntries(SETTLEMENT_FAULTS.map((f) => [f, f === fault ? 1 : 0])) as Record<SettlementFault, number> }
}

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  stack = await startStack()
  cleanup.defer(() => stack.close())
  today = stack.psp.settlements.calendar().current_day
})

afterAll(() => cleanup.disposeAsync())

describe('settlement', () => {
  it('ingests a closed day once, posts what the file says, and finds nothing to report', async () => {
    await stack.call('POST', '/v1/payments', { body: pay(1500) })
    const refunded = PaymentView.parse((await stack.call('POST', '/v1/payments', { body: pay(2400) })).body)
    await stack.call('POST', `/v1/payments/${refunded.id}/refunds`, { body: { amount: 400 } })
    const manual = PaymentView.parse((await stack.call('POST', '/v1/payments', { body: pay(1500, { capture: 'manual' }) })).body)
    await stack.call('POST', `/v1/payments/${manual.id}/capture`, { body: { amount: 900 } })

    const first = await ingest(today)
    expect(first).toMatchObject({
      outcome: 'ingested',
      reconciliation: {
        lines: 4,
        matched: 4,
        late: 0,
        pending: 0,
        breaks: { missing_line: 0, duplicate_line: 0, wrong_amount: 0, fee_difference: 0, unknown_line: 0 },
      },
    })
    const file = firstRow(
      await stack.admin.query<{ id: string; gross: string; fee: string; net: string }>(
        'SELECT id, gross::text, fee::text, net::text FROM settlement_files WHERE day = $1',
        [today],
      ),
    )
    expect(file).toMatchObject({ gross: String(1500 + 2400 - 400 + 900), fee: String(26 + 37 + 19) })
    const { rows: entries } = await stack.admin.query<{ code: string; amount: string }>(
      `SELECT a.code, e.amount::text FROM journals j JOIN entries e ON e.journal_id = j.id JOIN accounts a ON a.id = e.account_id
       WHERE j.external_ref = $1 ORDER BY a.code`,
      [`settlement:${file.id}`],
    )
    expect(entries).toEqual([
      { code: 'bank:EUR', amount: file.net },
      { code: 'psp_fee_expense:EUR', amount: file.fee },
      { code: 'psp_receivable:EUR', amount: `-${file.gross}` },
    ])
    expect(SettlementView.parse((await stack.call('POST', `/v1/settlements/${today}/ingest`, { as: 'admin' })).body).outcome).toBe('already')
    const days = await stack.call('GET', '/v1/reconciliation/days', { as: 'admin' })
    expect(days.body).toMatchObject({ day_seconds: 86_400, data: [{ day: today, id: file.id, lines: 4, gross: file.gross, breaks: {} }] })
    expect((await stack.call('GET', '/v1/reconciliation/days')).status).toBe(403)
    const day = SettlementDayView.parse((await stack.call('GET', `/v1/reconciliation/days/${today}`, { as: 'admin' })).body)
    expect(day).toMatchObject({ day: today, file: { id: file.id, lines: 4 }, breaks: [] })
    expect(day.lines.map((l) => [l.kind, l.break])).toEqual([
      ['capture', null],
      ['capture', null],
      ['refund', null],
      ['capture', null],
    ])
    expect(violations(await checkLedger(stack.admin))).toEqual([])
    const l5 = await checkSettlement(stack.admin, { daySeconds: 86_400, feeBps: 120, feeFixed: 8, completeThrough: today })
    expect(l5.examples).toEqual([])
  })

  it('reports each file fault as its own break, and places a line without references when one ledger item fits', async () => {
    const scenario = async (fault: SettlementFault, amount: number, day: number) => {
      stack.psp.faults.plan = only(fault)
      const payment = PaymentView.parse((await stack.call('POST', '/v1/payments', { body: pay(amount) })).body)
      const ingested = await ingest(day)
      stack.psp.faults.plan = NO_FAULTS
      return { payment: payment.id, ingested }
    }
    const blind = await scenario('droppedReference', 1777, today + 1)
    expect(await breaksFor(blind.payment)).toEqual([])
    expect(blind.ingested.reconciliation?.breaks.unknown_line).toBe(0)
    expect(await breaksFor((await scenario('wrongAmount', 1500, today + 2)).payment)).toEqual(['wrong_amount'])
    expect(await breaksFor((await scenario('feeDifference', 1500, today + 3)).payment)).toEqual(['fee_difference'])
    expect(await breaksFor((await scenario('duplicateLine', 1500, today + 4)).payment)).toEqual(['duplicate_line'])
    expect(await breaksFor((await scenario('missingLine', 1500, today + 5)).payment)).toEqual(['missing_line'])
    const listed = BreakList.parse((await stack.call('GET', `/v1/reconciliation/breaks?from=${today}&through=${today + 5}`, { as: 'admin' })).body)
    expect(listed.data.map((b) => b.class).sort()).toEqual(['duplicate_line', 'fee_difference', 'missing_line', 'wrong_amount'])
  })

  it('refuses a query it cannot use, and says which parameter is wrong', async () => {
    const refused = async (path: string) => (await stack.call('GET', path, { as: 'admin' })).body
    const message = (text: string) => ({ error: { code: 'invalid_request', message: text } })
    expect(await refused('/v1/reconciliation/days?limit=0')).toEqual(message('limit must be between 1 and 60'))
    expect(await refused('/v1/reconciliation/days?limit=7.5')).toEqual(message('limit must be between 1 and 60'))
    expect(await refused('/v1/reconciliation/days?currency=eur')).toEqual(message('currency must be a three-letter currency code'))
    expect(await refused('/v1/reconciliation/days/1e3')).toEqual(message('day must be a day number'))
    expect(await refused('/v1/reconciliation/breaks')).toEqual(message('from must be a day number'))
    expect(await refused(`/v1/reconciliation/breaks?from=${today}&through=-1`)).toEqual(message('through must be a day number'))
    expect(await refused('/v1/reconciliation/days?sort=day')).toEqual(message('property sort should not exist'))
    expect((await stack.call('GET', '/v1/reconciliation/days', { as: 'admin' })).status).toBe(200)
  })
})
