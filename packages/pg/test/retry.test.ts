import { describe, expect, it } from 'vitest'
import { RetriesExhaustedError, sqlStateOf, withRetry } from '../src/index.ts'

const noSleep = async () => undefined
const options = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 10 }

function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code })
}

describe('withRetry', () => {
  it('retries serialization failures and deadlocks until one attempt succeeds', async () => {
    const errors = [pgError('40001'), pgError('40P01')]
    const result = await withRetry(
      async () => {
        const error = errors.shift()
        if (error) throw error
        return 'done'
      },
      options,
      noSleep,
    )
    expect(result).toEqual({ value: 'done', attempts: 3 })
  })

  it('does not retry other errors', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw pgError('23505')
        },
        options,
        noSleep,
      ),
    ).rejects.toThrow('pg 23505')
    expect(calls).toBe(1)
  })

  it('gives up after the maximum number of attempts', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw pgError('40001')
        },
        options,
        noSleep,
      ),
    ).rejects.toBeInstanceOf(RetriesExhaustedError)
    expect(calls).toBe(4)
  })
})

describe('sqlStateOf', () => {
  it('reads a pg error', () => {
    expect(sqlStateOf(pgError('LG002'))).toBe('LG002')
  })

  it('reads a state wrapped as a cause', () => {
    expect(sqlStateOf(new Error('outer', { cause: pgError('40P01') }))).toBe('40P01')
  })

  it('prefers the driver state inside a Prisma error', () => {
    const error = Object.assign(new Error('prisma'), {
      code: 'P2010',
      clientVersion: '7',
      meta: { driverAdapterError: { cause: { originalCode: 'LG003' } } },
    })
    expect(sqlStateOf(error)).toBe('LG003')
  })

  it('maps Prisma codes without a driver state', () => {
    expect(sqlStateOf(Object.assign(new Error('prisma'), { code: 'P2034', clientVersion: '7' }))).toBe('40001')
    expect(sqlStateOf(Object.assign(new Error('prisma'), { code: 'P2025', clientVersion: '7' }))).toBeUndefined()
  })

  it('returns nothing for an error without a state', () => {
    expect(sqlStateOf(new Error('plain'))).toBeUndefined()
  })
})
