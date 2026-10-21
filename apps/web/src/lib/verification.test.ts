import { describe, expect, it } from 'vitest'
import { isOpen, percentDone, type VerificationRun } from './verification'

function run(status: VerificationRun['status'], progress: VerificationRun['progress'] = null): VerificationRun {
  return {
    id: '1',
    status,
    requested_at: '2026-10-21T18:00:00.000Z',
    started_at: null,
    finished_at: null,
    attempts: 0,
    progress,
    report: null,
    error: null,
  }
}

describe('a verification run on the audit page', () => {
  it('is open while it waits for the worker or runs, and closed once it ends either way', () => {
    expect([run('queued'), run('running'), run('done'), run('failed')].map(isOpen)).toEqual([true, true, false, false])
    expect(isOpen(null)).toBe(false)
  })

  it('shows no progress before the worker knows the size of the log', () => {
    expect(percentDone(run('running'))).toBe(0)
    expect(percentDone(run('running', { done: 0, size: 0 }))).toBe(0)
  })

  it('rounds down, so a run shows 100 only when every journal is checked', () => {
    expect(percentDone(run('running', { done: 999, size: 1000 }))).toBe(99)
    expect(percentDone(run('running', { done: 1000, size: 1000 }))).toBe(100)
  })
})
