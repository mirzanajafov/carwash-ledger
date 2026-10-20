import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  completedBy,
  consistencyProof,
  fromHex,
  inclusionProof,
  leafHash,
  nodesFor,
  rootFromLeaves,
  rootOf,
  toHex,
  verifyConsistency,
  verifyInclusion,
  type Hash,
} from '../src/index.ts'

const CT_LEAVES = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f']
const CT_ROOTS = [
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
]

function store(leaves: readonly Hash[]) {
  const nodes = new Map<string, Hash>()
  const source = (level: number, index: number) => {
    const hash = nodes.get(`${level}:${index}`)
    if (!hash) throw new Error(`no subtree ${level}:${index}`)
    return hash
  }
  leaves.forEach((leaf, index) => {
    for (const node of completedBy(index, leaf, source)) nodes.set(`${node.level}:${node.index}`, node.hash)
  })
  return source
}

const leavesOf = (n: number, seed: number) => Array.from({ length: n }, (_, i) => leafHash(Uint8Array.of(seed & 0xff, i & 0xff, (i >> 8) & 0xff)))

describe('the Merkle tree', () => {
  it('gives the Certificate Transparency roots for the first eight test leaves', () => {
    const leaves = CT_LEAVES.map((hex) => leafHash(fromHex(hex)))
    const source = store(leaves)
    for (let size = 1; size <= 8; size++) {
      expect(toHex(rootFromLeaves(leaves.slice(0, size)))).toBe(CT_ROOTS[size - 1])
      expect(toHex(rootOf(size, source))).toBe(CT_ROOTS[size - 1])
    }
  })

  it('computes every root from the stored complete subtrees, reading only a logarithmic number of them', () => {
    const leaves = leavesOf(300, 1)
    const source = store(leaves)
    for (const size of [1, 2, 3, 7, 8, 9, 100, 255, 256, 257, 300]) {
      expect(toHex(rootOf(size, source))).toBe(toHex(rootFromLeaves(leaves.slice(0, size))))
      expect(nodesFor((s) => rootOf(size, s)).length).toBeLessThanOrEqual(Math.ceil(Math.log2(size)) + 1)
    }
  })

  it('proves every leaf is in every tree that contains it, and a changed proof or leaf fails', () => {
    const leaves = leavesOf(130, 2)
    const source = store(leaves)
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 130 }), fc.nat(), fc.nat(), (size, pick, flip) => {
        const index = pick % size
        const root = rootOf(size, source)
        const proof = inclusionProof(index, size, source)
        expect(proof.length).toBeLessThanOrEqual(Math.ceil(Math.log2(size)))
        expect(verifyInclusion(leaves[index]!, index, size, proof, root)).toBe(true)
        if (size > 1) expect(verifyInclusion(leaves[(index + 1) % size]!, index, size, proof, root)).toBe(false)
        if (proof.length > 0) {
          const bad = proof.map((p) => Uint8Array.from(p))
          const at = flip % bad.length
          bad[at]![flip % 32]! ^= 1 << flip % 8
          expect(verifyInclusion(leaves[index]!, index, size, bad, root)).toBe(false)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('proves that every smaller tree is a prefix of every larger one, and nothing else', () => {
    const leaves = leavesOf(130, 3)
    const other = leavesOf(130, 4)
    const source = store(leaves)
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 130 }), fc.integer({ min: 1, max: 130 }), (a, b) => {
        const [first, second] = a <= b ? [a, b] : [b, a]
        const proof = consistencyProof(first, second, source)
        const firstRoot = rootOf(first, source)
        const secondRoot = rootOf(second, source)
        expect(verifyConsistency(first, second, firstRoot, secondRoot, proof)).toBe(true)
        const forked = rootFromLeaves([...other.slice(0, first)])
        if (first < second) expect(verifyConsistency(first, second, forked, secondRoot, proof)).toBe(false)
      }),
      { numRuns: 300 },
    )
  })
})
