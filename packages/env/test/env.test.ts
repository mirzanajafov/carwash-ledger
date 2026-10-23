import { describe, expect, it } from 'vitest'
import { nonNegativeInteger, optional, positiveInteger, positiveNumber, required } from '../src/index.ts'

describe('reading the environment', () => {
  it('falls back only when a number is missing or empty, and refuses anything that is not a whole number', () => {
    expect(nonNegativeInteger({}, 'PORT', 3140)).toBe(3140)
    expect(nonNegativeInteger({ PORT: '' }, 'PORT', 3140)).toBe(3140)
    expect(nonNegativeInteger({ PORT: '3150' }, 'PORT', 3140)).toBe(3150)
    for (const bad of ['abc', '1.5', '-1', '1e400', ' ', '0x78', '1e4', '99999999999999999999']) {
      expect(() => nonNegativeInteger({ PORT: bad }, 'PORT', 3140)).toThrow('PORT must be a non-negative integer')
    }
  })

  it('refuses zero where only a positive number makes sense', () => {
    expect(() => positiveInteger({ PER_MINUTE: '0' }, 'PER_MINUTE', 12)).toThrow('PER_MINUTE must be a positive integer')
    expect(positiveInteger({}, 'PER_MINUTE', 12)).toBe(12)
  })

  it('takes a fractional rate, and refuses zero, signs and anything else', () => {
    expect(positiveNumber({ PER_MINUTE: '0.5' }, 'PER_MINUTE', 12)).toBe(0.5)
    expect(positiveNumber({}, 'PER_MINUTE', 12)).toBe(12)
    for (const bad of ['0', '0.0', '-1', ' ', 'abc', '1e2'])
      expect(() => positiveNumber({ PER_MINUTE: bad }, 'PER_MINUTE', 12)).toThrow('PER_MINUTE must be a positive number')
  })

  it('treats an empty value as missing', () => {
    expect(() => required({ TOKEN: '' }, 'TOKEN')).toThrow('TOKEN is required')
    expect(required({ TOKEN: 't' }, 'TOKEN')).toBe('t')
    expect(optional({ URL: '' }, 'URL')).toBeUndefined()
  })
})
