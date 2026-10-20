import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { sequenceBatch } from '@carwash/audit-pg'
import { PgCtePoster } from '@carwash/ledger'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Database } from '../src/db/database.ts'
import { Chart } from '../src/ledger/chart.service.ts'
import { PAYMENTS } from '../src/live/live-feed.ts'
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
        if (Date.now() - started > timeoutMs) throw new Error(`gave up waiting, saw ${JSON.stringify(events.map((e) => e.type))}`)
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

  it('finds the last minute of payments through the primary key, not by scanning them all', async () => {
    const client = await stack.admin.connect()
    let plan = ''
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL enable_seqscan = off')
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${PAYMENTS}`)
      plan = rows.map((r) => r['QUERY PLAN']).join('\n')
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect(plan).toMatch(/Index Scan (using|on) payments_pkey/)
    expect(plan).toMatch(/Index Cond: \(id >= /)
  })

  it('keeps up when the log holds more than a batch of journals, and never replays old ones as new', async () => {
    const pool = stack.app.get(Database).pool
    const chart = stack.app.get(Chart)
    const accounts = chart.accounts('EUR')
    const poster = new PgCtePoster(pool, chart.registry)
    const before = BigInt((await pool.query<{ id: string }>('SELECT coalesce(max(id), 0)::text AS id FROM journals')).rows[0]!.id)
    for (let i = 0; i < 700; i++) {
      await poster.post({
        externalRef: `live-backlog:${i}`,
        entries: [
          { accountId: accounts.receivable.id, amount: 1n },
          { accountId: accounts.fees.id, amount: -1n },
        ],
      })
    }
    const live = await watch(`${stack.url}/v1/live`)
    try {
      await live.until((events) => events.some((e) => e.type === 'balances'))
      await sleep(2500)
      const old = live.events.filter((e) => e.type === 'journal' && BigInt(e.data.id) > before)
      expect(old.length).toBeLessThanOrEqual(20)
      const created = await stack.call('POST', '/v1/payments', { body: pay(1500) })
      await live.until((events) => events.some((e) => e.type === 'journal' && e.data.external_ref === `capture:${created.body.id}`), 5000)
      const replayed = live.events.filter((e) => e.type === 'journal' && e.data.external_ref.startsWith('live-backlog:'))
      expect(replayed.length).toBeLessThanOrEqual(20)
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
        expect(
          (await stack.call('POST', '/v1/admin/plug', { as: 'admin', body: { failpoint: 'post.after_lock' }, key: null, base: restarted.url })).status,
        ).toBe(429)
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

describe('admin sessions', () => {
  async function login(): Promise<{ token: string; id: string; expires_at: string }> {
    const opened = await stack.call('POST', '/v1/admin/sessions', { as: 'admin', key: null })
    expect(opened.status).toBe(201)
    return opened.body
  }

  it('opens a session with an admin key only, and the session works like the key without minting more', async () => {
    expect((await stack.call('POST', '/v1/admin/sessions', { key: null })).status).toBe(403)
    expect((await stack.call('POST', '/v1/admin/sessions', { as: 'nobody', key: null })).status).toBe(401)
    const session = await login()
    expect(session.token).toMatch(/^cw_session_[\w-]{43}$/)
    const hours = (Date.parse(session.expires_at) - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(11.9)
    expect(hours).toBeLessThan(12 + 1 / 60)
    const stored = await stack.admin.query('SELECT token_hash FROM dashboard_sessions WHERE id = $1', [session.id])
    expect(stored.rows[0].token_hash).toEqual(createHash('sha256').update(session.token).digest())
    expect(await stack.call('GET', '/v1/admin/sessions/current', { bearer: session.token })).toMatchObject({
      status: 200,
      body: { id: session.id, client: expect.any(String) },
    })
    expect((await stack.call('GET', '/v1/reconciliation/days', { bearer: session.token })).status).toBe(200)
    expect((await stack.call('POST', '/v1/admin/sessions', { bearer: session.token, key: null })).status).toBe(403)
    expect((await stack.call('GET', '/v1/admin/sessions/current', { as: 'admin' })).status).toBe(404)
  })

  it('ends on logout, at expiry, and when its key is revoked', async () => {
    const out = await login()
    expect((await stack.call('DELETE', '/v1/admin/sessions/current', { bearer: out.token })).body).toMatchObject({ id: out.id, revoked: true })
    const after = await stack.call('GET', '/v1/admin/sessions/current', { bearer: out.token })
    expect(after).toMatchObject({ status: 401, body: { error: { message: 'the session has ended' } } })

    const expired = await login()
    await stack.admin.query(`UPDATE dashboard_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [expired.id])
    expect((await stack.call('GET', '/v1/admin/sessions/current', { bearer: expired.token })).status).toBe(401)

    const { rows } = await stack.admin.query<{ id: string }>(
      `INSERT INTO api_clients (name, key_hash, scope) VALUES ('short-lived', sha256('cw_admin_short'::bytea), 'admin') RETURNING id::text`,
    )
    const opened = await stack.call('POST', '/v1/admin/sessions', { bearer: 'cw_admin_short', key: null })
    expect(opened.status).toBe(201)
    await stack.admin.query('UPDATE api_clients SET revoked_at = now() WHERE id = $1', [rows[0]!.id])
    expect((await stack.call('GET', '/v1/admin/sessions/current', { bearer: opened.body.token })).status).toBe(401)
    expect((await stack.call('GET', '/v1/admin/sessions/current', { bearer: 'cw_session_made-up' })).status).toBe(401)
  })

  it('lets a session skip the global turns that the dashboard key waits for', async () => {
    const session = await login()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await stack.call('POST', '/v1/admin/plug', { as: 'admin', body: { failpoint: 'post.after_lock' }, key: null })
      expect((await stack.call('POST', '/v1/admin/plug', { as: 'admin', body: { failpoint: 'post.after_lock' }, key: null })).status).toBe(429)
      for (let i = 0; i < 3; i++) {
        expect((await stack.call('POST', '/v1/admin/plug', { bearer: session.token, body: { failpoint: 'post.after_lock' }, key: null })).status).toBe(202)
      }
    } finally {
      kill.mockRestore()
      const { disarmFailpoints } = await import('@carwash/failpoints')
      disarmFailpoints()
    }
  })
})
