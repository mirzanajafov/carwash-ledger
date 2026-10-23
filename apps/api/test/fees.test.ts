import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { feeRefund, platformFee } from '../src/payments/fees.ts'

describe('the platform fee', () => {
  it('charges 2% plus 10 cents on the design doc example', () => {
    expect(platformFee(1500n, { bps: 200, fixed: 10n })).toBe(40n)
  })

  it('gives back exactly the whole fee over any split of a full refund, never more than each refund', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 11n, max: 10_000_000n }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 12 }),
        (captured, weights) => {
          const fee = platformFee(captured, { bps: 200, fixed: 10n })
          fc.pre(fee < captured)
          const total = weights.reduce((sum, w) => sum + w, 0)
          let left = captured
          const parts = weights.map((w, i) => {
            const part = i === weights.length - 1 ? left : (captured * BigInt(w)) / BigInt(total)
            left -= part
            return part
          })
          let refunded = 0n
          let returned = 0n
          for (const part of parts.filter((p) => p > 0n)) {
            const back = feeRefund(fee, captured, refunded, part)
            expect(back).toBeGreaterThanOrEqual(0n)
            expect(back).toBeLessThanOrEqual(part)
            refunded += part
            returned += back
          }
          expect(refunded).toBe(captured)
          expect(returned).toBe(fee)
        },
      ),
    )
  })
})
