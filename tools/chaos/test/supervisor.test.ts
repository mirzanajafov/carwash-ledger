import { afterEach, describe, expect, it, vi } from 'vitest'
import { Supervisor } from '../src/supervisor.ts'

afterEach(() => {
  vi.useRealTimers()
})

function watched() {
  let starts = 0
  return {
    restartable: { start: () => starts++ },
    startsAfter(ms: number): void {
      const before = starts
      vi.advanceTimersByTime(ms - 1)
      expect(starts).toBe(before)
      vi.advanceTimersByTime(1)
      expect(starts).toBe(before + 1)
    },
    get starts() {
      return starts
    },
  }
}

describe('restarting a process', () => {
  it('waits 500 ms after an ordinary exit, and doubles the wait up to 4 s while the process keeps failing to boot', () => {
    vi.useFakeTimers()
    const supervisor = new Supervisor()
    const child = watched()
    for (const ms of [1000, 2000, 4000, 4000]) {
      supervisor.restartAfterFailedBoot(child.restartable)
      child.startsAfter(ms)
    }
    supervisor.restart(child.restartable)
    child.startsAfter(500)
    supervisor.restartAfterFailedBoot(child.restartable)
    child.startsAfter(1000)
  })

  it('starts nothing once the run stops restarting, not even what was already waiting', () => {
    vi.useFakeTimers()
    const supervisor = new Supervisor()
    const child = watched()
    supervisor.restart(child.restartable)
    supervisor.stopRestarting()
    supervisor.restartAfterFailedBoot(child.restartable)
    vi.advanceTimersByTime(10_000)
    expect(child.starts).toBe(0)
  })
})
