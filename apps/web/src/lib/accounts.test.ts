import { describe, expect, it } from 'vitest'
import { programOf } from './accounts'

describe('the wash program of a payment', () => {
  it('is the program with that price, and custom for any other amount', () => {
    expect(programOf(1500)).toBe('Foam')
    expect(programOf('900')).toBe('Basic')
    expect(programOf(1234)).toBe('Custom')
  })
})
