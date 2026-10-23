import { BreakList, PaymentView, SettlementDayView, SettlementView } from '@carwash/contracts'
import { checkLedger, checkSettlement, violations } from '@carwash/invariants'
import { firstRow, inRollback, takeAdvisoryLock } from '@carwash/pg'
import { NO_FAULTS, SETTLEMENT_FAULTS, type SettlementFault } from '@carwash/psp'
import type { INestApplicationContext } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PspClient } from '../src/psp/psp.client.ts'
import { ReconciliationService } from '../src/settlement/reconciliation.service.ts'
import { SettlementIngestService } from '../src/settlement/settlement-ingest.service.ts'
import { settlementsKey } from '../src/settlement/settlements.repository.ts'
import { WorkerModule } from '../src/worker/worker.module.ts'
import { count, invalid, startStack, type Stack } from './support.ts'

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

async function latestDay(): Promise<number> {
  return firstRow(await stack.admin.query<{ day: number }>('SELECT max(day)::int AS day FROM settlement_files')).day
}

async function withWorker(currentDay: number, work: (worker: INestApplicationContext) => Promise<void>, config = stack.config): Promise<void> {
  const calendar = vi.spyOn(PspClient.prototype, 'calendar').mockResolvedValue({ kind: 'answer', daySeconds: 86_400, currentDay })
  const worker = await NestFactory.createApplicationContext(WorkerModule.register(config), { logger: false })
  try {
    await work(worker)
  } finally {
    calendar.mockRestore()
    await worker.close()
  }
}

async function waitingForTheLock(): Promise<number> {
  return count(
    stack.admin,
    `SELECT count(*)::int AS n FROM pg_locks
     WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1 AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [settlementsKey('EUR')],
  )
}

async function cursor(currency: string): Promise<{ files: number; version: string } | undefined> {
  const { rows } = await stack.admin.query<{ files: number; version: string }>('SELECT files, xmin::text AS version FROM recon_cursors WHERE currency = $1', [
    currency,
  ])
  return rows[0]
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

  it('makes an ingest wait for one in progress of the same currency, so the second answers already', async () => {
    const day = (await latestDay()) + 1
    stack.psp.faults.plan = only('wrongAmount')
    try {
      const payment = PaymentView.parse((await stack.call('POST', '/v1/payments', { body: pay(1500) })).body)
      await stack.psp.settlements.close(day)
      const { replies } = await inRollback(stack.admin, async (client) => {
        await takeAdvisoryLock(client, settlementsKey('EUR'))
        const replies = Promise.all([1, 2].map(() => stack.call('POST', `/v1/settlements/${day}/ingest`, { as: 'admin' })))
        await vi.waitFor(async () => expect(await waitingForTheLock()).toBe(2), { timeout: 10_000 })
        return { replies }
      })
      const answered = await replies
      expect(answered.map((reply) => reply.status)).toEqual([201, 201])
      expect(answered.map((reply) => SettlementView.parse(reply.body).outcome).sort()).toEqual(['already', 'ingested'])
      expect(await breaksFor(payment.id)).toEqual(['wrong_amount'])
    } finally {
      stack.psp.faults.plan = NO_FAULTS
    }
  })

  it('makes a reconcile wait for another one of the same currency to write, so each break is kept once', async () => {
    const reconciliation = stack.app.get(ReconciliationService)
    const duplicates = `SELECT count(*)::int AS n FROM (
      SELECT 1 FROM recon_breaks GROUP BY currency, day, class, file_id, line, journal_ref, attempt_id, detail HAVING count(*) > 1) d`
    expect(await count(stack.admin, 'SELECT count(*)::int AS n FROM recon_breaks')).toBeGreaterThan(0)
    const { reconciled } = await inRollback(stack.admin, async (client) => {
      await takeAdvisoryLock(client, settlementsKey('EUR'))
      const reconciled = Promise.all([1, 2].map(() => reconciliation.reconcile('EUR', 86_400)))
      await vi.waitFor(async () => expect(await waitingForTheLock()).toBe(2), { timeout: 10_000 })
      return { reconciled }
    })
    await reconciled
    expect(await count(stack.admin, duplicates)).toBe(0)
  })

  it('refuses a query it cannot use, and says which parameter is wrong', async () => {
    const get = (path: string) => stack.call('GET', path, { as: 'admin' })
    expect(await get('/v1/reconciliation/days?limit=0')).toEqual(invalid('limit must be between 1 and 60'))
    expect(await get('/v1/reconciliation/days?limit=')).toEqual(invalid('limit must be between 1 and 60'))
    expect(await get('/v1/reconciliation/days?limit=7.5')).toEqual(invalid('limit must be between 1 and 60'))
    expect(await get('/v1/reconciliation/days?currency=eur')).toEqual(invalid('currency must be a three-letter currency code'))
    expect(await get('/v1/reconciliation/days/1e3')).toEqual(invalid('day must be a day number'))
    expect(await get('/v1/reconciliation/breaks')).toEqual(invalid('from must be a day number'))
    expect(await get(`/v1/reconciliation/breaks?from=${today}&through=-1`)).toEqual(invalid('through must be a day number'))
    expect(await get('/v1/reconciliation/days?sort=day')).toEqual(invalid('property sort should not exist'))
    expect((await get('/v1/reconciliation/days')).status).toBe(200)
  })

  it('catches up on every closed day it has not ingested yet', async () => {
    const latest = await latestDay()
    const days = [latest + 1, latest + 2]
    for (const day of days) await stack.psp.settlements.close(day)
    await withWorker(latest + 3, async (worker) => {
      const ingest = worker.get(SettlementIngestService)
      expect(await ingest.catchUp()).toBe(2)
      const { rows } = await stack.admin.query<{ day: number }>('SELECT day::int AS day FROM settlement_files WHERE day = ANY($1) ORDER BY day', [days])
      expect(rows.map((row) => row.day)).toEqual(days)
      expect(await ingest.catchUp()).toBe(0)
    })
  })

  it('reconciles on the next catch-up when the reconcile after an ingest failed, and not again after that', async () => {
    const latest = await latestDay()
    await stack.psp.settlements.close(latest + 1)
    const reconcile = vi.spyOn(ReconciliationService.prototype, 'reconcileIfDue').mockRejectedValueOnce(new Error('the database went away'))
    try {
      await withWorker(latest + 2, async (worker) => {
        const ingest = worker.get(SettlementIngestService)
        await expect(ingest.catchUp()).rejects.toThrow('EUR: the database went away')
        expect(await ingest.catchUp()).toBe(0)
        const files = await count(stack.admin, "SELECT count(*)::int AS n FROM settlement_files WHERE currency = 'EUR'")
        const reconciled = await cursor('EUR')
        expect(reconciled?.files).toBe(files)
        expect(await ingest.catchUp()).toBe(0)
        expect(await cursor('EUR')).toEqual(reconciled)
      })
    } finally {
      reconcile.mockRestore()
    }
  })

  it('keeps catching up the other currencies when one of them fails', async () => {
    const latest = await latestDay()
    await stack.admin.query("INSERT INTO settlement_files (id, day, currency, lines, gross, fee, net) VALUES ($1, $2, 'USD', 0, 0, 0, 0)", [
      `stl_USD_${latest}`,
      latest,
    ])
    await stack.psp.settlements.close(latest + 1)
    const config = { ...stack.config, core: { ...stack.config.core, currencies: ['USD', 'EUR'] } }
    await withWorker(
      latest + 2,
      async (worker) => {
        const psp = worker.get(PspClient)
        const fetchFile = psp.settlementFile.bind(psp)
        vi.spyOn(psp, 'settlementFile').mockImplementation((day, currency) =>
          currency === 'USD' ? Promise.reject(new Error('the bank is down for USD')) : fetchFile(day, currency),
        )
        await expect(worker.get(SettlementIngestService).catchUp()).rejects.toThrow('USD: the bank is down for USD')
        expect(await latestDay()).toBe(latest + 1)
        expect((await cursor('EUR'))?.files).toBe(await count(stack.admin, "SELECT count(*)::int AS n FROM settlement_files WHERE currency = 'EUR'"))
        expect((await cursor('USD'))?.files).toBe(1)
      },
      config,
    )
  })
})
