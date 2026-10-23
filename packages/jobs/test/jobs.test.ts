import { describe, expect, it } from 'vitest'
import { exponentialBackoff, linearBackoff, retryUntilStopped, runEvery } from '../src/index.ts'

describe('a job that runs every interval', () => {
  it('keeps running through failures, logs the first and every nth in a row, and counts again after a success', async () => {
    const stop = new AbortController()
    const outcomes = ['fail', 'fail', 'fail', 'fail', 'ok', 'fail', 'fail']
    const logged: string[] = []
    let calls = 0
    const task = async () => {
      const outcome = outcomes[calls++]
      if (calls === outcomes.length) stop.abort()
      if (outcome === 'fail') throw new Error(`failure ${calls}`)
    }
    await runEvery('sweep', 1, task, { signal: stop.signal, log: (message) => logged.push(message), logEvery: 2 })
    expect(calls).toBe(outcomes.length)
    expect(logged).toEqual(['sweep: failure 1', 'sweep: failure 2', 'sweep: failure 4', 'sweep: failure 6', 'sweep: failure 7'])
  })

  it('waits the interval between runs', async () => {
    const stop = new AbortController()
    const started: number[] = []
    const task = async () => {
      started.push(performance.now())
      if (started.length === 4) stop.abort()
    }
    await runEvery('tick', 20, task, { signal: stop.signal, log: () => undefined })
    const gaps = started.slice(1).map((at, i) => at - (started[i] ?? at))
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(15)
  })
})

describe('a retry loop', () => {
  it('waits the delay for each failure count and stops at the first success', async () => {
    const delays: number[] = []
    let calls = 0
    const task = async () => {
      if (++calls < 4) throw new Error('not yet')
    }
    const delayMs = (failures: number) => {
      delays.push(failures)
      return 1
    }
    await retryUntilStopped('start', delayMs, task, { signal: new AbortController().signal, log: () => undefined })
    expect(calls).toBe(4)
    expect(delays).toEqual([1, 2, 3])
  })

  it('gives up in the middle of a wait once it is stopped', async () => {
    const stop = new AbortController()
    let calls = 0
    const task = async () => {
      calls++
      setTimeout(() => stop.abort(), 10)
      throw new Error('down')
    }
    const started = performance.now()
    await retryUntilStopped('start', () => 60_000, task, { signal: stop.signal, log: () => undefined })
    expect(performance.now() - started).toBeLessThan(5000)
    expect(calls).toBe(1)
  })
})

describe('backoff', () => {
  it('doubles from 100 ms and stops at two seconds', () => {
    expect([1, 2, 5, 6, 20].map(exponentialBackoff)).toEqual([100, 200, 1600, 2000, 2000])
  })

  it('grows by 250 ms and stops at five seconds', () => {
    expect([1, 2, 20, 21].map(linearBackoff)).toEqual([250, 500, 5000, 5000])
  })
})
