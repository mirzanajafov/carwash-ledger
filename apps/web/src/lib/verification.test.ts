import { describe, expect, it } from 'vitest'
import { isOpen, percentDone, startedBeforeTamper, type VerificationRun } from './verification'

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

function finished(startedAt: string, findings: number): VerificationRun {
  return {
    ...run('done'),
    started_at: startedAt,
    finished_at: startedAt,
    report: { size: 40, journals: 40, witnessed: 16, findings, firstSeq: null, examples: [], ms: { read: 1, compute: 1, yielded: 0, total: 2 } },
  }
}

describe('a verification run on the audit page', () => {
  it('is open while it waits for the worker or runs, and closed once it ends either way', () => {
    expect([run('queued'), run('running'), run('done'), run('failed')].map(isOpen)).toEqual([true, true, false, false])
    expect(isOpen(null)).toBe(false)
  })

  it('shows no progress before the worker knows the size of the log', () => {
    expect(percentDone(run('running'))).toBe(0)
    expect(percentDone(run('running', { checked: 0, size: 0 }))).toBe(0)
  })

  it('says when a clean run started before the tamper on the page, so it is not read as missing it', () => {
    expect(startedBeforeTamper(finished('2026-10-21T18:00:00.000Z', 0), '2026-10-21T18:00:05.000Z')).toBe(true)
    expect(startedBeforeTamper(finished('2026-10-21T18:00:10.000Z', 0), '2026-10-21T18:00:05.000Z')).toBe(false)
    expect(startedBeforeTamper(finished('2026-10-21T18:00:00.000Z', 1), '2026-10-21T18:00:05.000Z')).toBe(false)
    expect(startedBeforeTamper(finished('2026-10-21T18:00:00.000Z', 0), null)).toBe(false)
  })

  it('rounds down, so a run shows 100 only when every journal is checked', () => {
    expect(percentDone(run('running', { checked: 999, size: 1000 }))).toBe(99)
    expect(percentDone(run('running', { checked: 1000, size: 1000 }))).toBe(100)
  })
})
