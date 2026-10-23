import { performance } from 'node:perf_hooks'
import { setImmediate as yieldToLoop, setTimeout as sleep } from 'node:timers/promises'
import { mulberry32, percentile } from '@carwash/lab'

export type Outcome = 'ok' | 'gave-up'

export interface LoadOptions {
  rate: number
  durationMs: number
  warmupMs: number
  seed: number
  maxInFlight: number
  task: (index: number) => Promise<Outcome>
}

export interface Distribution {
  p50: number
  p90: number
  p99: number
  p999: number
  max: number
}

export interface LoadResult {
  offeredPerSecond: number
  measured: number
  completed: number
  gaveUp: number
  errors: number
  dropped: number
  achievedPerSecond: number
  latencyMs: Distribution
  lagMs: Distribution
  generatorCpuPercent: number
  firstError?: string
}

export function poissonSchedule(rate: number, totalMs: number, seed: number): Float64Array {
  const random = mulberry32(seed)
  const times: number[] = []
  let t = 0
  for (;;) {
    t += (-Math.log(1 - random()) / rate) * 1000
    if (t >= totalMs) break
    times.push(t)
  }
  return Float64Array.from(times)
}

function distribution(values: number[]): Distribution {
  const sorted = Float64Array.from(values).sort()
  return {
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    p999: percentile(sorted, 99.9),
    max: sorted.at(-1) ?? Number.NaN,
  }
}

export async function runOpenLoop(options: LoadOptions): Promise<LoadResult> {
  const schedule = poissonSchedule(options.rate, options.warmupMs + options.durationMs, options.seed)
  const latencies: number[] = []
  const lags: number[] = []
  let inFlight = 0
  let completed = 0
  let completedInWindow = 0
  const windowEnd = options.warmupMs + options.durationMs
  let gaveUp = 0
  let errors = 0
  let dropped = 0
  let measured = 0
  let firstError: string | undefined
  const pending = new Set<Promise<void>>()

  let cpuAtStart = process.cpuUsage()
  let wallAtStart = 0
  let measuring = false

  const start = performance.now()
  let next = 0
  while (next < schedule.length) {
    const now = performance.now() - start
    for (;;) {
      const scheduled = schedule[next]
      if (scheduled === undefined || scheduled > now) break
      const index = next++
      const counted = scheduled >= options.warmupMs
      if (counted && !measuring) {
        measuring = true
        cpuAtStart = process.cpuUsage()
        wallAtStart = performance.now()
      }
      if (counted) {
        measured++
        lags.push(performance.now() - start - scheduled)
      }
      if (inFlight >= options.maxInFlight) {
        if (counted) dropped++
        continue
      }
      inFlight++
      const job = options
        .task(index)
        .then(
          (outcome) => {
            if (!counted) return
            if (outcome === 'ok') {
              const finished = performance.now() - start
              completed++
              if (finished <= windowEnd) completedInWindow++
              latencies.push(finished - scheduled)
            } else {
              gaveUp++
            }
          },
          (error: unknown) => {
            if (!counted) return
            errors++
            firstError ??= error instanceof Error ? error.message : String(error)
          },
        )
        .finally(() => {
          inFlight--
          pending.delete(job)
        })
      pending.add(job)
    }
    const upcoming = schedule[next]
    if (upcoming === undefined) break
    const wait = upcoming - (performance.now() - start)
    if (wait > 2) await sleep(wait - 1.5)
    else await yieldToLoop()
  }
  const wallAtEnd = performance.now()
  const cpu = process.cpuUsage(cpuAtStart)
  await Promise.all(pending)

  return {
    offeredPerSecond: options.rate,
    measured,
    completed,
    gaveUp,
    errors,
    dropped,
    achievedPerSecond: completedInWindow / (options.durationMs / 1000),
    latencyMs: distribution(latencies),
    lagMs: distribution(lags),
    generatorCpuPercent: ((cpu.user + cpu.system) / 1000 / Math.max(1, wallAtEnd - wallAtStart)) * 100,
    ...(firstError === undefined ? {} : { firstError }),
  }
}
