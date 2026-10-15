import { describe, expect, it } from 'vitest'
import { campaignFailed } from '../src/results.ts'

describe('a campaign that should fail CI', () => {
  it('fails on any run with a violation or any harness error, and passes a clean one', () => {
    expect(campaignFailed({ runsWithViolations: 0, harnessErrors: 0 })).toBe(false)
    expect(campaignFailed({ runsWithViolations: 1, harnessErrors: 0 })).toBe(true)
    expect(campaignFailed({ runsWithViolations: 0, harnessErrors: 2 })).toBe(true)
  })
})
