import { describe, expect, it } from 'vitest'
import { envelope, laneSql, LANES } from '../src/index.ts'

describe('envelope', () => {
  it('carries the event id, type and time of the outbox row around its payload', () => {
    const row = {
      id: '42',
      lane: 3,
      eventId: '0199d5a0-0000-7000-8000-000000000001',
      topic: 'payments',
      key: 'p1',
      type: 'payment.captured',
      payload: { id: 'p1', status: 'captured' },
      createdAt: new Date('2026-10-13T08:00:00.123Z'),
    }
    expect(envelope(row)).toEqual({
      id: '0199d5a0-0000-7000-8000-000000000001',
      type: 'payment.captured',
      occurred_at: '2026-10-13T08:00:00.123Z',
      data: { id: 'p1', status: 'captured' },
    })
  })

  it('masks the key hash down to one of the lanes', () => {
    expect(LANES & (LANES - 1)).toBe(0)
    expect(laneSql('$2')).toBe(`(hashtextextended($2, 0) & ${LANES - 1})::smallint`)
  })
})
