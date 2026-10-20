import { describe, expect, it } from 'vitest'
import { pullThePlug, type PlugDeps, type Reply, type Step } from './plug'

function fakeApi(script: { pay: (Reply | Error)[]; health: (string | null)[]; checks?: Reply[] }) {
  let clock = 0
  const sent: string[] = []
  const deps: PlugDeps = {
    arm: async () => ({ status: 202, body: { pid: 7, started_at: 'first' }, retryAfter: null }),
    pay: async (key) => {
      sent.push(key)
      const next = script.pay.shift()
      if (!next) throw new Error('no more answers')
      if (next instanceof Error) throw next
      return next
    },
    health: async () => {
      const started = script.health.shift()
      return started === undefined || started === null ? null : { pid: 7, startedAt: started }
    },
    checks: async () =>
      script.checks?.shift() ?? { status: 200, body: { ms: 12, results: [{ id: 'S1', description: 'balanced', count: 0, examples: [] }] }, retryAfter: null },
    key: () => 'key-1',
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
  }
  return { deps, sent }
}

async function run(deps: PlugDeps): Promise<Step[]> {
  const steps: Step[] = []
  for await (const step of pullThePlug(deps, 'attempt.after_psp', 'wash_north')) steps.push(step)
  return steps
}

describe('pulling the plug', () => {
  it("waits for a new process, even one with the same pid, retries the same key past the dead request's lease, and ends with the checks", async () => {
    const { deps, sent } = fakeApi({
      pay: [
        new Error('socket hang up'),
        { status: 503, body: { error: { code: 'database_unavailable' } }, retryAfter: 1 },
        { status: 409, body: { error: { code: 'request_in_progress' } }, retryAfter: 5 },
        { status: 200, body: { id: 'pay_1', status: 'captured' }, retryAfter: null },
      ],
      health: [null, null, 'first', 'second'],
    })
    const steps = await run(deps)
    expect(steps.map((s) => s.kind)).toEqual(['armed', 'sent', 'lost', 'back', 'retry', 'retry', 'answered', 'checks'])
    expect(steps.find((s) => s.kind === 'back')).toMatchObject({ pid: 7, startedAt: 'second' })
    expect(steps.find((s) => s.kind === 'answered')).toMatchObject({ attempt: 4, status: 200, paymentId: 'pay_1', paymentStatus: 'captured' })
    expect(new Set(sent)).toEqual(new Set(['key-1']))
  })

  it('reports a plug somebody else pulled a moment ago instead of sending anything', async () => {
    const { deps, sent } = fakeApi({ pay: [], health: [] })
    deps.arm = async () => ({ status: 429, body: { error: { message: 'this can run again in 40 s' } }, retryAfter: 40 })
    expect(await run(deps)).toEqual([{ kind: 'refused', at: 0, status: 429, message: 'this can run again in 40 s' }])
    expect(sent).toEqual([])
  })

  it('gives up with a clear step when the API never comes back', async () => {
    const { deps } = fakeApi({ pay: [new Error('ECONNREFUSED')], health: [] })
    const steps = await run(deps)
    expect(steps.at(-1)).toMatchObject({ kind: 'failed', message: 'the API did not come back in time' })
  })
})
