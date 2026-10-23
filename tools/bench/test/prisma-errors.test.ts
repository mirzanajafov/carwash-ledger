import { Prisma } from '@carwash/db'
import { sqlStateOf } from '@carwash/pg'
import { describe, expect, it } from 'vitest'
import { asPgError } from '../src/prisma-posters.ts'

function prismaError(code: string, meta: Record<string, unknown> = {}): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`prisma ${code}`, { code, clientVersion: '7', meta })
}

describe('a Prisma error seen as a Postgres one', () => {
  it("carries the driver's state and message when the adapter reports one", () => {
    const error = asPgError(prismaError('P2010', { driverAdapterError: { cause: { originalCode: 'LG003', originalMessage: 'journal does not balance' } } }))
    expect(sqlStateOf(error)).toBe('LG003')
    expect(error).toMatchObject({ message: 'journal does not balance' })
  })

  it('maps the Prisma codes that have a state, and leaves the others alone', () => {
    expect(sqlStateOf(asPgError(prismaError('P2034')))).toBe('40001')
    expect(sqlStateOf(asPgError(prismaError('P2002')))).toBe('23505')
    const other = prismaError('P2025')
    expect(asPgError(other)).toBe(other)
  })
})
