import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import * as z from 'zod/mini'
import { Frontier, leafHash, rootFromLeaves, toHex } from '../src/index.ts'

const SavedFrontier = z.object({ size: z.number(), edge: z.array(z.string()) })

const leavesOf = (n: number, seed: number) => Array.from({ length: n }, (_, i) => leafHash(Uint8Array.of(seed & 0xff, i & 0xff, (i >> 8) & 0xff)))

describe('the frontier', () => {
  it('gives the same root as the whole tree at every size, keeping one subtree per set bit of the size', () => {
    const leaves = leavesOf(600, 3)
    const frontier = new Frontier()
    expect(toHex(frontier.root())).toBe(toHex(rootFromLeaves([])))
    leaves.forEach((leaf, i) => {
      frontier.push(leaf)
      expect(frontier.size).toBe(i + 1)
      expect(toHex(frontier.root())).toBe(toHex(rootFromLeaves(leaves.slice(0, i + 1))))
      expect(frontier.toJSON().edge).toHaveLength((i + 1).toString(2).replaceAll('0', '').length)
    })
  })

  it('picks up from a saved state exactly where it stopped', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 200 }), fc.nat(255), (first, more, seed) => {
        const leaves = leavesOf(first + more, seed)
        const before = new Frontier()
        for (const leaf of leaves.slice(0, first)) before.push(leaf)
        const resumed = Frontier.from(SavedFrontier.parse(JSON.parse(JSON.stringify(before.toJSON()))))
        for (const leaf of leaves.slice(first)) resumed.push(leaf)
        expect(toHex(resumed.root())).toBe(toHex(rootFromLeaves(leaves)))
      }),
    )
  })

  it('refuses a saved state whose edge does not fit its size', () => {
    const frontier = new Frontier()
    for (const leaf of leavesOf(6, 1)) frontier.push(leaf)
    const state = frontier.toJSON()
    expect(() => Frontier.from({ ...state, size: 7 })).toThrow(/right edge/)
    expect(() => Frontier.from({ ...state, size: -1 })).toThrow(RangeError)
  })
})
