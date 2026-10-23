import { describe, expect, it } from 'vitest'
import { describeError } from '../src/messages.ts'

describe('how the harness writes down an error', () => {
  it('names the error, its code and every cause behind it', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3140'), { code: 'ECONNREFUSED' })
    const fetchFailed = new TypeError('fetch failed', { cause: refused })
    expect(describeError(new Error('settling day 3', { cause: fetchFailed }))).toBe(
      'Error: settling day 3, caused by TypeError: fetch failed, caused by Error ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:3140',
    )
  })

  it('writes anything thrown that is not an error as it is', () => {
    expect(describeError('lease lost')).toBe('lease lost')
  })
})
