import { setTimeout as sleep } from 'node:timers/promises'
import { sequenceBatch } from '@carwash/audit-pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Database } from '../src/db/database.ts'
import { startApi, startStack, type Stack } from './support.ts'

let stack: Stack

interface Event {
  type: string
  data: any
}

function pay(amount: number) {
  return { amount, currency: 'EUR', merchant: 'wash_1', token: 'tok_ok' }
}

async function watch(url: string) {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  const events: Event[] = []
  const decoder = new TextDecoder()
  let buffer = ''
  const reading = (async () => {
    const reader = response.body!.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const type = /^event: (.+)$/m.exec(block)?.[1]
        const data = /^data: (.+)$/m.exec(block)?.[1]
        if (type && data) events.push({ type, data: JSON.parse(data) })
      }
    }
  })().catch(() => undefined)
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    events,
    async until(found: (events: Event[]) => boolean, timeoutMs = 10_000) {
      const started = Date.now()
      while (!found(events)) {
        if (Date.now() - started > timeoutMs) throw new Error(`gave up waiting; saw ${JSON.stringify(events.map((e) => e.type))}`)
        await sleep(50)
      }
    },
    async close() {
      controller.abort()
      await reading
    },
  }
}

async function sequenceAll(): Promise<void> {
  const db = stack.app.get(Database)
  while ((await db.transaction((client) => sequenceBatch(client, 1000))) > 0);
}

beforeAll(async () => {
  stack = await startStack()
})

afterAll(async () => {
  await stack?.close()
})

describe('the live feed', () => {
  it('streams balances, every new journal with its entries, and payments as they move, to anyone', async () => {
    const live = await watch(`${stack.url}/v1/live`)
    try {
      expect(live.status).toBe(200)
      expect(live.contentType).toMatch(/text\/event-stream/)
      await live.until((events) => events.some((e) => e.type === 'balances'))
      const created = await stack.call('POST', '/v1/payments', { body: pay(2400) })
      expect(created.body.status).toBe('captured')
      await live.until(
        (events) =>
          events.some((e) => e.type === 'journal' && e.data.external_ref.startsWith('capture:')) &&
          events.some((e) => e.type === 'payment' && e.data.id === created.body.id && e.data.status === 'captured'),
      )
      const journal = live.events.find((e) => e.type === 'journal' && e.data.external_ref.startsWith('capture:'))!
      expect(journal.data.entries.reduce((sum: bigint, e: { amount: string }) => sum + BigInt(e.amount), 0n)).toBe(0n)
      await live.until((events) => events.filter((e) => e.type === 'balances').length >= 2)
      const balances = live.events.filter((e) => e.type === 'balances').at(-1)!.data as { code: string; amount: string }[]
      expect(balances.reduce((sum, b) => sum + BigInt(b.amount), 0n)).toBe(0n)
      expect(balances.some((b) => b.amount !== '0')).toBe(true)

      const late = await watch(`${stack.url}/v1/live`)
      try {
        await late.until(
          (events) =>
            events.some((e) => e.type === 'balances') &&
            events.some((e) => e.type === 'journal' && e.data.id === journal.data.id) &&
            events.some((e) => e.type === 'payment' && e.data.id === created.body.id),
          3000,
        )
      } finally {
        await late.close()
      }
    } finally {
      await live.close()
    }
  })
})

describe('the admin side of the dashboard', () => {
  it('arms one failpoint once for the plug, for admins only, and at most once a minute', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      expect((await stack.call('POST', '/v1/admin/plug', { body: { failpoint: 'attempt.after_psp' }, key: null })).status).toBe(403)
      expect((await stack.call('POST', '/v1/admin/plug', { as: 'admin', body: { failpoint: 'ledger.drop_table' }, key: null })).status).toBe(400)
      const armed = await stack.call('POST', '/v1/admin/plug', { as: 'admin', body: { failpoint: 'attempt.after_psp' }, key: null })
      expect(armed).toMatchObject({ status: 202, body: { failpoint: 'attempt.after_psp', pid: process.pid } })
      expect((await stack.call('POST', '/v1/payments', { body: pay(900) })).status).toBe(200)
      expect(kill).toHaveBeenCalledTimes(1)
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL')
      expect((await stack.call('POST', '/v1/payments', { body: pay(900) })).status).toBe(200)
      expect(kill).toHaveBeenCalledTimes(1)
      const again = await stack.call('POST', '/v1/admin/plug', { as: 'admin', body: { failpoint: 'post.after_lock' }, key: null })
      expect(again.status).toBe(429)
      expect(Number(again.retryAfter)).toBeGreaterThan(50)
      const restarted = await startApi(stack.config)
      try {
        expect((await stack.call('POST', '/v1/admin/plug', { as: 'admin', body: { failpoint: 'post.after_lock' }, key: null, base: restarted.url })).status).toBe(429)
      } finally {
        await restarted.app.close()
      }
    } finally {
      kill.mockRestore()
    }
  })

  it('runs the invariants and the verifier on demand as the audit role, and finds nothing wrong', async () => {
    await sequenceAll()
    expect((await stack.call('POST', '/v1/admin/checks', { key: null })).status).toBe(403)
    const checks = await stack.call('POST', '/v1/admin/checks', { as: 'admin', key: null })
    expect(checks.status).toBe(200)
    expect(checks.body.results.map((r: { id: string }) => r.id)).toEqual(['S1', 'S2', 'S3', 'S5', 'S6', 'S7', 'L4'])
    expect(checks.body.results.filter((r: { count: number }) => r.count > 0)).toEqual([])
    const verified = await stack.call('POST', '/v1/admin/verify', { as: 'admin', key: null })
    expect(verified).toMatchObject({ status: 200, body: { object: 'verification', mode: 'full', findings: 0 } })
    expect(verified.body.journals).toBeGreaterThan(0)
  })
})
