import { describe, expect, it } from 'vitest'
import { constraintOf, sqlStateOf } from '../src/index.ts'

function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`pg ${code}`), constraint === undefined ? { code } : { code, constraint })
}

describe('what a Postgres error says about itself', () => {
  it('names its SQL state, also when it is wrapped as a cause, and nothing for an error without one', () => {
    expect(sqlStateOf(pgError('LG002'))).toBe('LG002')
    expect(sqlStateOf(new Error('outer', { cause: pgError('40P01') }))).toBe('40P01')
    expect(sqlStateOf(new Error('plain'))).toBeUndefined()
  })

  it('names the constraint it broke, also when it is wrapped as a cause', () => {
    const unique = pgError('23505', 'journals_external_ref_key')
    expect(constraintOf(unique)).toBe('journals_external_ref_key')
    expect(constraintOf(new Error('outer', { cause: unique }))).toBe('journals_external_ref_key')
    expect(constraintOf(new Error('plain'))).toBeUndefined()
  })
})
