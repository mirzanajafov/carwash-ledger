import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { drive, startClock, type DriveOptions, type Phases } from '../src/drive.ts'

const OPTIONS: DriveOptions = { durationMs: 40, settleMs: 1000, checkEveryMs: 5, settledEveryMs: 5 }

function phases(overrides: Partial<Phases> = {}) {
  const calls: string[] = []
  let checking = 0
  let mostAtOnce = 0
  const recorded: Phases = {
    startDue: () => calls.push('due'),
    endFaults: () => {
      calls.push('end')
      return Promise.resolve()
    },
    canCheck: () => true,
    check: async () => {
      calls.push('check')
      mostAtOnce = Math.max(mostAtOnce, ++checking)
      await sleep(12)
      checking--
    },
    settled: () => {
      calls.push('settled?')
      return Promise.resolve(calls.filter((call) => call === 'settled?').length >= 3)
    },
    ...overrides,
  }
  return { recorded, calls, mostAtOnce: () => mostAtOnce }
}

describe('the fault phase and the settling after it', () => {
  it('starts what is due until the deadline, ends the faults once, then waits until the run has settled', async () => {
    const run = phases()
    const driven = await drive(startClock(), OPTIONS, run.recorded)
    await driven.lastCheck
    expect(run.calls.filter((call) => call === 'end')).toHaveLength(1)
    expect(run.calls.lastIndexOf('due')).toBeLessThan(run.calls.indexOf('end'))
    expect(run.calls.indexOf('end')).toBeLessThan(run.calls.indexOf('settled?'))
    expect(run.calls.filter((call) => call === 'settled?')).toHaveLength(3)
    expect(driven.settled).toBe(true)
  })

  it('runs one check at a time, and none while checking is not possible', async () => {
    const run = phases()
    await (
      await drive(startClock(), OPTIONS, run.recorded)
    ).lastCheck
    expect(run.calls).toContain('check')
    expect(run.mostAtOnce()).toBe(1)

    const blocked = phases({ canCheck: () => false })
    await drive(startClock(), OPTIONS, blocked.recorded)
    expect(blocked.calls).not.toContain('check')
  })

  it('gives up when the run has not settled in time', async () => {
    const driven = await drive(startClock(), { ...OPTIONS, settleMs: 20 }, phases({ settled: () => Promise.resolve(false) }).recorded)
    expect(driven.settled).toBe(false)
    expect(driven.settleMs).toBeGreaterThanOrEqual(20)
  })

  it('hands back the check still running when it returns, so the final checks can wait for it, and the errors of failed checks', async () => {
    let finished = false
    const driven = await drive(
      startClock(),
      { ...OPTIONS, durationMs: 10, checkEveryMs: 1 },
      {
        ...phases().recorded,
        check: async () => {
          await sleep(100)
          finished = true
        },
        settled: () => Promise.resolve(true),
      },
    )
    expect(finished).toBe(false)
    await driven.lastCheck
    expect(finished).toBe(true)
    expect(driven.checkErrors).toEqual([])

    const failing = await drive(startClock(), OPTIONS, { ...phases().recorded, check: () => Promise.reject(new Error('the audit pool is gone')) })
    await failing.lastCheck
    expect(failing.checkErrors.length).toBeGreaterThan(0)
    expect(String(failing.checkErrors[0])).toContain('the audit pool is gone')
  })
})
