import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { NestFactory } from '@nestjs/core'
import { restore, sequenceBatch, tamper } from '@carwash/audit-pg'
import type { Env } from '@carwash/env'
import {
  InvariantChecksView,
  LiveBalance,
  LiveJournal,
  LivePayment,
  liveEvent,
  OpenedSessionView,
  PaymentView,
  SessionView,
  VerificationRunView,
  type LiveEvent,
} from '@carwash/contracts'
import { PgCtePoster } from '@carwash/ledger'
import { firstRow, inRollback, withTransaction } from '@carwash/pg'
import { afterAll, assert, beforeAll, describe, expect, it, vi } from 'vitest'
import { VerificationJob } from '../src/audit/verification-job.ts'
import { VerificationRuns } from '../src/audit/verification-runs.ts'
import { Database } from '../src/db/database.ts'
import { Chart } from '../src/ledger/chart.service.ts'
import { PAYMENTS } from '../src/live/live-feed.ts'
import { WorkerModule } from '../src/worker/worker.module.ts'
import { startApi, startStack, testConfig, type Stack } from './support.ts'

let stack: Stack

function journalsIn(events: readonly LiveEvent[]): LiveJournal[] {
  return events.flatMap((event) => (event.type === 'journal' ? [event.data] : []))
}

function paymentsIn(events: readonly LiveEvent[]): LivePayment[] {
  return events.flatMap((event) => (event.type === 'payment' ? [event.data] : []))
}

function balancesIn(events: readonly LiveEvent[]): LiveBalance[][] {
  return events.flatMap((event) => (event.type === 'balances' ? [event.data] : []))
}

function pay(amount: number) {
  return { amount, currency: 'EUR', merchant: 'wash_1', token: 'tok_ok' }
}

async function watch(url: string) {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  assert(response.body)
  const reader = response.body.getReader()
  const events: LiveEvent[] = []
  const decoder = new TextDecoder()
  let buffer = ''
  const reading = (async () => {
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
        const live = type && data ? liveEvent(type, JSON.parse(data)) : undefined
        if (live) events.push(live)
      }
    }
  })().catch(() => undefined)
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    events,
    async until(found: (events: LiveEvent[]) => boolean, timeoutMs = 10_000) {
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

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  stack = await startStack()
  cleanup.defer(() => stack.close())
})

afterAll(() => cleanup.disposeAsync())

describe('the live feed', () => {
  it('streams balances, every new journal with its entries, and payments as they move, to anyone', async () => {
    const live = await watch(`${stack.url}/v1/live`)
    try {
      expect(live.status).toBe(200)
      expect(live.contentType).toMatch(/text\/event-stream/)
      await live.until((events) => events.some((e) => e.type === 'balances'))
      const created = PaymentView.parse((await stack.call('POST', '/v1/payments', { body: pay(2400) })).body)
      expect(created.status).toBe('captured')
      await live.until(
        (events) =>
          journalsIn(events).some((j) => j.external_ref.startsWith('capture:')) &&
          paymentsIn(events).some((p) => p.id === created.id && p.status === 'captured'),
      )
      const journal = journalsIn(live.events).find((j) => j.external_ref.startsWith('capture:'))
      assert(journal)
      expect(journal.entries.reduce((sum, e) => sum + BigInt(e.amount), 0n)).toBe(0n)
      await live.until((events) => balancesIn(events).length >= 2)
      const balances = balancesIn(live.events).at(-1)
      assert(balances)
      expect(balances.reduce((sum, b) => sum + BigInt(b.amount), 0n)).toBe(0n)
      expect(balances.some((b) => b.amount !== '0')).toBe(true)

      const late = await watch(`${stack.url}/v1/live`)
      try {
        await late.until(
          (events) =>
            balancesIn(events).length > 0 && journalsIn(events).some((j) => j.id === journal.id) && paymentsIn(events).some((p) => p.id === created.id),
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
    const plan = await inRollback(stack.admin, async (client) => {
      await client.query('SET LOCAL enable_seqscan = off')
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${PAYMENTS}`)
      return rows.map((r) => r['QUERY PLAN']).join('\n')
    })
    expect(plan).toMatch(/Index Scan (using|on) payments_pkey/)
    expect(plan).toMatch(/Index Cond: \(id >= /)
  })

  it('keeps up when the log holds more than a batch of journals, and never replays old ones as new', async () => {
    const pool = stack.app.get(Database).pool
    const chart = stack.app.get(Chart)
    const accounts = chart.accounts('EUR')
    const poster = new PgCtePoster(pool, chart.registry)
    const before = BigInt(firstRow(await pool.query<{ id: string }>('SELECT coalesce(max(id), 0)::text AS id FROM journals')).id)
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
      const old = journalsIn(live.events).filter((j) => BigInt(j.id) > before)
      expect(old.length).toBeLessThanOrEqual(20)
      const created = PaymentView.parse((await stack.call('POST', '/v1/payments', { body: pay(1500) })).body)
      await live.until((events) => journalsIn(events).some((j) => j.external_ref === `capture:${created.id}`), 5000)
      const replayed = journalsIn(live.events).filter((j) => j.external_ref.startsWith('live-backlog:'))
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

  it('runs the invariants on demand as the audit role, and finds nothing wrong', async () => {
    await sequenceAll()
    expect((await stack.call('POST', '/v1/admin/checks', { key: null })).status).toBe(403)
    const answer = await stack.call('POST', '/v1/admin/checks', { as: 'admin', key: null })
    expect(answer.status).toBe(200)
    const checks = InvariantChecksView.parse(answer.body)
    expect(checks.results.map((r) => r.id)).toEqual(['S1', 'S2', 'S3', 'S5', 'S6', 'S7', 'L4'])
    expect(checks.results.filter((r) => r.count > 0)).toEqual([])
    expect(checks.payment_checks.since).toBeNull()
    expect(checks.payment_checks.payments).toBeGreaterThan(0)
  })

  it('answers 503 for the checks while the witness is not answering', async () => {
    const blind = await startApi(testConfig({ ...stack.env, WITNESS_URL: 'http://127.0.0.1:9', WITNESS_TOKEN: 'token' }))
    try {
      const answer = await stack.call('POST', '/v1/admin/checks', { as: 'admin', key: null, base: blind.url })
      expect(answer).toMatchObject({ status: 503, body: { error: { code: 'witness_unavailable' } } })
    } finally {
      await blind.app.close()
    }
  })
})

describe('verification runs', () => {
  async function withWorker<T>(work: (job: VerificationJob) => Promise<T>, env: Env = {}): Promise<T> {
    const worker = await NestFactory.createApplicationContext(WorkerModule.register(testConfig({ ...stack.env, ...env })), { logger: false })
    try {
      return await work(worker.get(VerificationJob))
    } finally {
      await worker.close()
    }
  }

  const request = () => stack.call('POST', '/v1/admin/verify', { as: 'admin', key: null })
  const latest = () => stack.call('GET', '/v1/audit/verification')
  const requestRun = async () => VerificationRunView.parse((await request()).body).id

  it('queues one run however often and however many at once ask for it, and the worker runs it to the end with its progress', async () => {
    await sequenceAll()
    expect((await latest()).status).toBe(404)
    const asked = await Promise.all([request(), request(), request(), request(), request()])
    expect(asked[0]).toMatchObject({ status: 202, body: { object: 'verification_run', status: 'queued', progress: null, report: null } })
    const ids = new Set(asked.map((answer) => VerificationRunView.parse(answer.body).id))
    expect(ids.size).toBe(1)
    const [id] = ids
    expect(await requestRun()).toBe(id)
    await withWorker(async (job) => {
      expect((await job.runNext())?.id).toBe(id)
      expect(await job.runNext()).toBeUndefined()
    })
    const finished = VerificationRunView.parse((await latest()).body)
    expect(finished).toMatchObject({ id, status: 'done', attempts: 1, error: null, report: { mode: 'full', findings: 0 } })
    assert(finished.report)
    expect(finished.report.journals).toBeGreaterThan(0)
    expect(finished.progress).toEqual({ checked: finished.report.size, size: finished.report.size })
    expect(await requestRun()).not.toBe(id)
  })

  it('finds a tamper committed before the run, and nothing once it is restored', async () => {
    await sequenceAll()
    const tampered = await withTransaction(stack.admin, (client) => tamper(client, 1, 1))
    try {
      await request()
      await withWorker((job) => job.runNext())
      expect((await latest()).body).toMatchObject({
        status: 'done',
        report: { firstSeq: 1, examples: [{ kind: 'leaf', seq: 1, journalId: tampered.journalId }] },
      })
    } finally {
      await withTransaction(stack.admin, (client) => restore(client, tampered))
    }
    await request()
    await withWorker((job) => job.runNext())
    expect((await latest()).body).toMatchObject({ status: 'done', report: { findings: 0 } })
  })

  it('takes over a run whose worker stopped, and gives up on one that stopped three times', async () => {
    const run = await requestRun()
    await stack.admin.query(`UPDATE verification_runs SET status = 'running', attempts = 1, locked_until = now() - interval '1 second' WHERE id = $1`, [run])
    await withWorker((job) => job.runNext())
    expect((await latest()).body).toMatchObject({ id: run, status: 'done', attempts: 2 })
    const stuck = await requestRun()
    await stack.admin.query(`UPDATE verification_runs SET status = 'running', attempts = 3, locked_until = now() - interval '1 second' WHERE id = $1`, [stuck])
    await withWorker(async (job) => {
      expect(await job.runNext()).toBeUndefined()
    })
    expect((await latest()).body).toMatchObject({ id: stuck, status: 'failed', error: 'the worker stopped during this run 3 times' })
  })

  it('ignores a worker whose run was taken over after its lease ran out', async () => {
    const runs = stack.app.get(VerificationRuns)
    await request()
    const stale = await runs.claim()
    await stack.admin.query(`UPDATE verification_runs SET locked_until = now() - interval '1 second' WHERE status = 'running'`)
    const current = await runs.claim()
    if (!stale || !current) throw new Error('no run was claimed')
    expect(current).toMatchObject({ id: stale.id, attempts: 2 })
    expect(await runs.progress(stale, 5, 10)).toBe(false)
    await runs.fail(stale, 'the stale worker failed')
    expect((await latest()).body).toMatchObject({ id: stale.id, status: 'running', attempts: 2, progress: null })
    expect(await runs.progress(current, 5, 10)).toBe(true)
    await runs.fail(current, 'the current worker failed')
    expect((await latest()).body).toMatchObject({ status: 'failed', progress: { checked: 5, size: 10 }, error: 'the current worker failed' })
  })

  it('leaves its run to the next worker when it stops in the middle, instead of failing it', async () => {
    await sequenceAll()
    const run = await requestRun()
    let stopping = Promise.resolve()
    await withTransaction(stack.admin, async (blocker) => {
      await blocker.query('LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE')
      const worker = await NestFactory.createApplicationContext(WorkerModule.register(testConfig({ ...stack.env, VERIFY_EVERY_MS: '20' })), { logger: false })
      try {
        await vi.waitFor(async () => expect((await latest()).body).toMatchObject({ status: 'running' }), { timeout: 5000 })
      } finally {
        stopping = worker.close()
      }
    })
    await stopping
    expect((await latest()).body).toMatchObject({ id: run, status: 'running', attempts: 1, progress: null })
    await stack.admin.query(`UPDATE verification_runs SET locked_until = now() - interval '1 second' WHERE id = $1`, [run])
    await withWorker((job) => job.runNext())
    expect((await latest()).body).toMatchObject({ id: run, status: 'done', attempts: 2 })
  })

  it('will not start a worker that cannot read the ledger as the audit role', async () => {
    const starting = NestFactory.createApplicationContext(WorkerModule.register(testConfig({ ...stack.env, AUDIT_DATABASE_URL: undefined })), {
      logger: false,
      abortOnError: false,
    })
    await expect(starting).rejects.toThrow('AUDIT_DATABASE_URL is required in the worker')
  })

  it('queues a run again when the witness cannot be read, and fails it on the third attempt without saying where the witness lives', async () => {
    const run = await requestRun()
    await withWorker(
      async (job) => {
        await job.runNext()
        expect((await latest()).body).toMatchObject({ id: run, status: 'queued', attempts: 1, error: null })
        await job.runNext()
        await job.runNext()
      },
      { WITNESS_URL: 'http://127.0.0.1:9', WITNESS_TOKEN: 'token' },
    )
    expect((await latest()).body).toMatchObject({ id: run, status: 'failed', attempts: 3, error: 'the witness could not be read', report: null })
  })
})

describe('admin sessions', () => {
  async function login(): Promise<OpenedSessionView> {
    const opened = await stack.call('POST', '/v1/admin/sessions', { as: 'admin', key: null })
    expect(opened.status).toBe(201)
    return OpenedSessionView.parse(opened.body)
  }

  it('opens a session with an admin key only, and the session works like the key without minting more', async () => {
    expect((await stack.call('POST', '/v1/admin/sessions', { key: null })).status).toBe(403)
    expect((await stack.call('POST', '/v1/admin/sessions', { as: 'nobody', key: null })).status).toBe(401)
    const session = await login()
    expect(session.token).toMatch(/^cw_session_[\w-]{43}$/)
    const hours = (Date.parse(session.expires_at) - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(11.9)
    expect(hours).toBeLessThan(12 + 1 / 60)
    const stored = firstRow(await stack.admin.query<{ token_hash: Buffer }>('SELECT token_hash FROM dashboard_sessions WHERE id = $1', [session.id]))
    expect(stored.token_hash).toEqual(createHash('sha256').update(session.token).digest())
    const current = await stack.call('GET', '/v1/admin/sessions/current', { bearer: session.token })
    expect(current.status).toBe(200)
    expect(SessionView.parse(current.body).id).toBe(session.id)
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

    const { id } = firstRow(
      await stack.admin.query<{ id: string }>(
        `INSERT INTO api_clients (name, key_hash, scope) VALUES ('short-lived', sha256('cw_admin_short'::bytea), 'admin') RETURNING id::text`,
      ),
    )
    const opened = await stack.call('POST', '/v1/admin/sessions', { bearer: 'cw_admin_short', key: null })
    expect(opened.status).toBe(201)
    await stack.admin.query('UPDATE api_clients SET revoked_at = now() WHERE id = $1', [id])
    expect((await stack.call('GET', '/v1/admin/sessions/current', { bearer: OpenedSessionView.parse(opened.body).token })).status).toBe(401)
    expect((await stack.call('GET', '/v1/admin/sessions/current', { bearer: 'cw_session_made-up' })).status).toBe(401)
  })

  it('answers a double-clicked logout without an error', async () => {
    for (let i = 0; i < 10; i++) {
      const session = await login()
      const logouts = await Promise.all([1, 2].map(() => stack.call('DELETE', '/v1/admin/sessions/current', { bearer: session.token })))
      expect(logouts.map((logout) => logout.status)).toContain(200)
      for (const logout of logouts) expect([200, 401]).toContain(logout.status)
    }
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
