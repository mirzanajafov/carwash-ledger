import { setTimeout as sleep } from 'node:timers/promises'

export type Clock = () => number

export function startClock(): Clock {
  const started = performance.now()
  return () => performance.now() - started
}

export interface DriveOptions {
  durationMs: number
  settleMs: number
  checkEveryMs: number
  settledEveryMs: number
}

export interface Phases {
  startDue(t: number): void
  endFaults(): Promise<void>
  tick?(t: number): void
  canCheck(): boolean
  check(): Promise<void>
  settled(settlingMs: number): Promise<boolean>
}

export interface Driven {
  settleMs: number
  settled: boolean
  lastCheck: Promise<void>
  checkErrors: unknown[]
}

export async function drive(now: Clock, options: DriveOptions, phases: Phases): Promise<Driven> {
  let checking: Promise<void> | undefined
  let checkedAt = 0
  let settledAt = 0
  let settleStarted: number | undefined
  let settled = true
  const checkErrors: unknown[] = []
  for (;;) {
    const t = now()
    if (settleStarted === undefined) {
      phases.startDue(t)
      if (t >= options.durationMs) {
        await phases.endFaults()
        settleStarted = now()
        continue
      }
    }
    phases.tick?.(t)
    if (checking === undefined && phases.canCheck() && t - checkedAt >= options.checkEveryMs) {
      checkedAt = t
      checking = phases
        .check()
        .catch((error: unknown) => {
          checkErrors.push(error)
        })
        .finally(() => {
          checking = undefined
        })
    }
    if (settleStarted !== undefined && t - settledAt >= options.settledEveryMs) {
      settledAt = t
      if (await phases.settled(t - settleStarted)) break
      if (t - settleStarted > options.settleMs) {
        settled = false
        break
      }
    }
    await sleep(5)
  }
  return { settleMs: Math.round(now() - settleStarted), settled, lastCheck: checking ?? Promise.resolve(), checkErrors }
}
