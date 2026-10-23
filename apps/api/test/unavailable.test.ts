import { describe, expect, it } from 'vitest'
import { databaseUnavailable } from '../src/db/unavailable.ts'

describe('telling a database outage from other errors', () => {
  function failure(message: string, code?: string): Error {
    return Object.assign(new Error(message), code === undefined ? {} : { code })
  }

  it('recognises a database that is down, restarting, cut off or out of connections, and nothing else', () => {
    expect(databaseUnavailable(failure('connect ECONNREFUSED 127.0.0.1:6432', 'ECONNREFUSED'))).toBe(true)
    expect(databaseUnavailable(failure('read ECONNRESET', 'ECONNRESET'))).toBe(true)
    expect(databaseUnavailable(failure('Connection terminated unexpectedly'))).toBe(true)
    expect(databaseUnavailable(failure('timeout exceeded when trying to connect'))).toBe(true)
    expect(databaseUnavailable(failure('Query read timeout'))).toBe(true)
    expect(databaseUnavailable(failure('the database system is not yet accepting connections', '57P03'))).toBe(true)
    expect(databaseUnavailable(failure('terminating connection due to administrator command', '57P01'))).toBe(true)
    expect(databaseUnavailable(failure('terminating connection due to transaction timeout', '25P04'))).toBe(true)
    expect(databaseUnavailable(failure('connection failure', '08006'))).toBe(true)
    expect(databaseUnavailable(failure('duplicate key value violates unique constraint', '23505'))).toBe(false)
    expect(databaseUnavailable(failure('journal does not balance', 'P0001'))).toBe(false)
    expect(databaseUnavailable(failure('fetch failed'))).toBe(false)
    expect(databaseUnavailable('Connection terminated')).toBe(false)
  })
})
