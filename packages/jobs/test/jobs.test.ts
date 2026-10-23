import { describe, expect, it } from 'vitest'
import { exponentialBackoff, linearBackoff, retryLoop, runEvery } from '../src/index.ts'

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
})

describe('a retry loop', () => {
  it('waits the delay for each failure count and returns the first success', async () => {
    const delays: number[] = []
    let calls = 0
    const task = async () => {
      if (++calls < 4) throw new Error('not yet')
      return 'started'
    }
    const delayMs = (failures: number) => {
      delays.push(failures)
      return 1
    }
    const started = await retryLoop('start', task, delayMs, { signal: new AbortController().signal, log: () => undefined })
    expect(started).toBe('started')
    expect(delays).toEqual([1, 2, 3])
  })

  it('gives up once it is stopped, even in the middle of a wait', async () => {
    const stop = new AbortController()
    const task = async () => {
      stop.abort()
      throw new Error('down')
    }
    await expect(retryLoop('start', task, () => 60_000, { signal: stop.signal, log: () => undefined })).resolves.toBeUndefined()
  })
})

describe('backoff', () => {
  it('doubles from 100 ms up to two seconds, or grows by 250 ms up to five', () => {
    expect([1, 2, 5, 6, 20].map(exponentialBackoff)).toEqual([100, 200, 1600, 2000, 2000])
    expect([1, 2, 20, 21].map(linearBackoff)).toEqual([250, 500, 5000, 5000])
  })
})
