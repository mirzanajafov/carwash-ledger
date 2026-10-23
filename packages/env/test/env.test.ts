import { describe, expect, it } from 'vitest'
import { integer, optional, positiveInteger, required } from '../src/index.ts'

describe('reading the environment', () => {
  it('falls back only when a number is missing or empty, and refuses anything that is not a whole number', () => {
    expect(integer({}, 'PORT', 3140)).toBe(3140)
    expect(integer({ PORT: '' }, 'PORT', 3140)).toBe(3140)
    expect(integer({ PORT: '3150' }, 'PORT', 3140)).toBe(3150)
    for (const bad of ['abc', '1.5', '-1', '1e400']) expect(() => integer({ PORT: bad }, 'PORT', 3140)).toThrow('PORT must be a non-negative integer')
  })

  it('refuses zero where only a positive number makes sense', () => {
    expect(() => positiveInteger({ PER_MINUTE: '0' }, 'PER_MINUTE', 12)).toThrow('PER_MINUTE must be a positive integer')
    expect(positiveInteger({}, 'PER_MINUTE', 12)).toBe(12)
  })

  it('treats an empty value as missing', () => {
    expect(() => required({ TOKEN: '' }, 'TOKEN')).toThrow('TOKEN is required')
    expect(required({ TOKEN: 't' }, 'TOKEN')).toBe('t')
    expect(optional({ URL: '' }, 'URL')).toBeUndefined()
  })
})
