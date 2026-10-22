import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { NestFactory } from '@nestjs/core'
import { restore, sequenceBatch, tamper } from '@carwash/audit-pg'
import { PgCtePoster } from '@carwash/ledger'
import { firstRow } from '@carwash/pg'
import { afterAll, assert, beforeAll, describe, expect, it, vi } from 'vitest'
import { VerificationJob } from '../src/audit/verification-job.ts'
import { VerificationRuns } from '../src/audit/verification-runs.ts'
import type { ApiConfig } from '../src/config.ts'
import { Database } from '../src/db/database.ts'
import { Chart } from '../src/ledger/chart.service.ts'
import { PAYMENTS } from '../src/live/live-feed.ts'
import { WorkerModule } from '../src/worker/worker.module.ts'
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
  assert(response.body)
  const reader = response.body.getReader()
  const events: Event[] = []
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
      const created = await stack.call('POST', '/v1/payments', { body: pay(2400) })
      expect(created.body.status).toBe('captured')
      await live.until(
        (events) =>
          events.some((e) => e.type === 'journal' && e.data.external_ref.startsWith('capture:')) &&
          events.some((e) => e.type === 'payment' && e.data.id === created.body.id && e.data.status === 'captured'),
      )
      const journal = live.events.find((e) => e.type === 'journal' && e.data.external_ref.startsWith('capture:'))
      assert(journal)
      expect(journal.data.entries.reduce((sum: bigint, e: { amount: string }) => sum + BigInt(e.amount), 0n)).toBe(0n)
      await live.until((events) => events.filter((e) => e.type === 'balances').length >= 2)
      const newest = live.events.filter((e) => e.type === 'balances').at(-1)
      assert(newest)
      const balances = newest.data as { code: string; amount: string }[]
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
    let plan: string
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

  it('runs the invariants on demand as the audit role, and finds nothing wrong', async () => {
    await sequenceAll()
    expect((await stack.call('POST', '/v1/admin/checks', { key: null })).status).toBe(403)
    const checks = await stack.call('POST', '/v1/admin/checks', { as: 'admin', key: null })
    expect(checks.status).toBe(200)
    expect(checks.body.results.map((r: { id: string }) => r.id)).toEqual(['S1', 'S2', 'S3', 'S5', 'S6', 'S7', 'L4'])
    expect(checks.body.results.filter((r: { count: number }) => r.count > 0)).toEqual([])
    expect(checks.body.payment_checks).toMatchObject({ since: null })
    expect(checks.body.payment_checks.payments).toBeGreaterThan(0)
  })

  it('answers 503 for the checks while the witness is not answering', async () => {
    const blind = await startApi({ ...stack.config, witnessUrl: 'http://127.0.0.1:9' })
    try {
      const answer = await stack.call('POST', '/v1/admin/checks', { as: 'admin', key: null, base: blind.url })
      expect(answer).toMatchObject({ status: 503, body: { error: { code: 'witness_unavailable' } } })
    } finally {
      await blind.app.close()
    }
  })
})

describe('verification runs', () => {
  async function withWorker<T>(work: (job: VerificationJob) => Promise<T>, config: Partial<ApiConfig> = {}): Promise<T> {
    const worker = await NestFactory.createApplicationContext(WorkerModule.register({ ...stack.config, ...config }), { logger: false })
    try {
      return await work(worker.get(VerificationJob))
    } finally {
      await worker.close()
    }
  }

  const request = () => stack.call('POST', '/v1/admin/verify', { as: 'admin', key: null })
  const latest = () => stack.call('GET', '/v1/audit/verification')

  it('queues one run however often and however many at once ask for it, and the worker runs it to the end with its progress', async () => {
    await sequenceAll()
    expect((await latest()).status).toBe(404)
    const asked = await Promise.all([request(), request(), request(), request(), request()])
    expect(asked[0]).toMatchObject({ status: 202, body: { object: 'verification_run', status: 'queued', progress: null, report: null } })
    const ids = new Set(asked.map((answer) => answer.body.id))
    expect(ids.size).toBe(1)
    const [id] = ids
    expect((await request()).body.id).toBe(id)
    await withWorker(async (job) => {
      expect((await job.runNext())?.id).toBe(id)
      expect(await job.runNext()).toBeUndefined()
    })
    const finished = await latest()
    expect(finished.body).toMatchObject({ id, status: 'done', attempts: 1, error: null, report: { mode: 'full', findings: 0 } })
    expect(finished.body.report.journals).toBeGreaterThan(0)
    expect(finished.body.progress).toEqual({ checked: finished.body.report.size, size: finished.body.report.size })
    expect((await request()).body.id).not.toBe(id)
  })

  it('finds a tamper committed before the run, and nothing once it is restored', async () => {
    await sequenceAll()
    const client = await stack.admin.connect()
    try {
      await client.query('BEGIN')
      const tampered = await tamper(client, 1, 1)
      await client.query('COMMIT')
      await request()
      await withWorker((job) => job.runNext())
      expect((await latest()).body).toMatchObject({
        status: 'done',
        report: { firstSeq: 1, examples: [{ kind: 'leaf', seq: 1, journalId: tampered.journalId }] },
      })
      await client.query('BEGIN')
      await restore(client, tampered)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    await request()
    await withWorker((job) => job.runNext())
    expect((await latest()).body).toMatchObject({ status: 'done', report: { findings: 0 } })
  })

  it('takes over a run whose worker stopped, and gives up on one that stopped three times', async () => {
    const run = (await request()).body.id
    await stack.admin.query(`UPDATE verification_runs SET status = 'running', attempts = 1, locked_until = now() - interval '1 second' WHERE id = $1`, [run])
    await withWorker((job) => job.runNext())
    expect((await latest()).body).toMatchObject({ id: run, status: 'done', attempts: 2 })
    const stuck = (await request()).body.id
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
    const run = (await request()).body.id
    const blocker = await stack.admin.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE')
      const worker = await NestFactory.createApplicationContext(WorkerModule.register({ ...stack.config, verifyEveryMs: 20 }), { logger: false })
      await vi.waitFor(async () => expect((await latest()).body.status).toBe('running'), { timeout: 5000 })
      const stopping = worker.close()
      await blocker.query('COMMIT')
      await stopping
    } finally {
      blocker.release()
    }
    expect((await latest()).body).toMatchObject({ id: run, status: 'running', attempts: 1, progress: null })
    await stack.admin.query(`UPDATE verification_runs SET locked_until = now() - interval '1 second' WHERE id = $1`, [run])
    await withWorker((job) => job.runNext())
    expect((await latest()).body).toMatchObject({ id: run, status: 'done', attempts: 2 })
  })

  it('will not start a worker that cannot read the ledger as the audit role', async () => {
    const starting = NestFactory.createApplicationContext(WorkerModule.register({ ...stack.config, auditDatabaseUrl: undefined }), {
      logger: false,
      abortOnError: false,
    })
    await expect(starting).rejects.toThrow('AUDIT_DATABASE_URL is required in the worker')
  })

  it('queues a run again when the witness cannot be read, and fails it on the third attempt without saying where the witness lives', async () => {
    const run = (await request()).body.id
    await withWorker(
      async (job) => {
        await job.runNext()
        expect((await latest()).body).toMatchObject({ id: run, status: 'queued', attempts: 1, error: null })
        await job.runNext()
        await job.runNext()
      },
      { witnessUrl: 'http://127.0.0.1:9', witnessToken: 'token' },
    )
    expect((await latest()).body).toMatchObject({ id: run, status: 'failed', attempts: 3, error: 'the witness could not be read', report: null })
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

    const { id } = firstRow(
      await stack.admin.query<{ id: string }>(
        `INSERT INTO api_clients (name, key_hash, scope) VALUES ('short-lived', sha256('cw_admin_short'::bytea), 'admin') RETURNING id::text`,
      ),
    )
    const opened = await stack.call('POST', '/v1/admin/sessions', { bearer: 'cw_admin_short', key: null })
    expect(opened.status).toBe(201)
    await stack.admin.query('UPDATE api_clients SET revoked_at = now() WHERE id = $1', [id])
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
