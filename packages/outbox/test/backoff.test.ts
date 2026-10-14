import { describe, expect, it } from 'vitest'
import { nextWait, RELAY_DEFAULTS } from '../src/relay.ts'

describe('the relay backoff', () => {
  it('doubles the wait while it finds nothing, up to the cap', () => {
    let idleMs = RELAY_DEFAULTS.pollMs
    const waits: number[] = []
    for (let i = 0; i < 8; i++) {
      const next = nextWait(idleMs, null, RELAY_DEFAULTS)
      waits.push(next.waitMs)
      idleMs = next.idleMs
    }
    expect(waits).toEqual([50, 100, 200, 400, 800, 1000, 1000, 1000])
  })

  it('goes back to the short poll as soon as a cycle publishes anything', () => {
    expect(nextWait(1000, { lanes: [3], published: 1 }, RELAY_DEFAULTS)).toEqual({ waitMs: RELAY_DEFAULTS.pauseMs, idleMs: 50 })
    expect(nextWait(1000, { lanes: [3], published: RELAY_DEFAULTS.batch }, RELAY_DEFAULTS)).toEqual({ waitMs: 0, idleMs: 50 })
  })

  it('never waits longer than the poll when the cap is below it', () => {
    expect(nextWait(50, null, { ...RELAY_DEFAULTS, idleMaxMs: 10 })).toEqual({ waitMs: 50, idleMs: 50 })
  })
})
