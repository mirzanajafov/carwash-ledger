import { sha256 } from '@noble/hashes/sha2.js'

export type Hash = Uint8Array

export interface Node {
  level: number
  index: number
}

export type SubtreeSource = (level: number, index: number) => Hash

const LEAF = Uint8Array.of(0x00)
const INTERIOR = Uint8Array.of(0x01)

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function leafHash(data: Uint8Array): Hash {
  return sha256(concat(LEAF, data))
}

export function nodeHash(left: Hash, right: Hash): Hash {
  return sha256(concat(INTERIOR, left, right))
}

export function chainHash(previous: Hash, leaf: Hash): Hash {
  return sha256(concat(previous, leaf))
}

export const EMPTY_CHAIN: Hash = new Uint8Array(32)

export function equal(a: Hash, b: Hash): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (const [i, byte] of a.entries()) {
    const other = b[i]
    if (other === undefined) return false
    diff |= byte ^ other
  }
  return diff === 0
}

export function toHex(hash: Hash): string {
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string): Hash {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error('not a hex string')
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

function largestPowerOfTwoBelow(n: number): number {
  let k = 1
  while (k * 2 < n) k *= 2
  return k
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0
}

function log2(n: number): number {
  return Math.log2(n) | 0
}

export function subtreeHash(start: number, size: number, source: SubtreeSource): Hash {
  if (size <= 0) throw new RangeError('an empty range has no hash')
  if (isPowerOfTwo(size) && start % size === 0) return source(log2(size), start / size)
  const k = largestPowerOfTwoBelow(size)
  return nodeHash(subtreeHash(start, k, source), subtreeHash(start + k, size - k, source))
}

export function rootOf(size: number, source: SubtreeSource): Hash {
  if (size === 0) return sha256(new Uint8Array(0))
  return subtreeHash(0, size, source)
}

export function inclusionProof(index: number, size: number, source: SubtreeSource): Hash[] {
  if (index < 0 || index >= size) throw new RangeError(`leaf ${index} is not in a tree of ${size}`)
  const path = (m: number, start: number, n: number): Hash[] => {
    if (n === 1) return []
    const k = largestPowerOfTwoBelow(n)
    if (m < k) return [...path(m, start, k), subtreeHash(start + k, n - k, source)]
    return [...path(m - k, start + k, n - k), subtreeHash(start, k, source)]
  }
  return path(index, 0, size)
}

export function consistencyProof(first: number, second: number, source: SubtreeSource): Hash[] {
  if (first <= 0 || first > second) throw new RangeError(`no consistency proof from ${first} to ${second}`)
  if (first === second) return []
  const subproof = (m: number, start: number, n: number, whole: boolean): Hash[] => {
    if (m === n) return whole ? [] : [subtreeHash(start, n, source)]
    const k = largestPowerOfTwoBelow(n)
    if (m <= k) return [...subproof(m, start, k, whole), subtreeHash(start + k, n - k, source)]
    return [...subproof(m - k, start + k, n - k, false), subtreeHash(start, k, source)]
  }
  return subproof(first, 0, second, true)
}

export function nodesFor(read: (source: SubtreeSource) => unknown): Node[] {
  const seen = new Map<string, Node>()
  read((level, index) => {
    seen.set(`${level}:${index}`, { level, index })
    return new Uint8Array(32)
  })
  return [...seen.values()]
}

export function verifyInclusion(leaf: Hash, index: number, size: number, proof: readonly Hash[], root: Hash): boolean {
  if (index < 0 || index >= size) return false
  let fn = index
  let sn = size - 1
  let r = leaf
  for (const p of proof) {
    if (sn === 0) return false
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r)
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2)
          sn = Math.floor(sn / 2)
        }
      }
    } else {
      r = nodeHash(r, p)
    }
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  return sn === 0 && equal(r, root)
}

export function verifyConsistency(first: number, second: number, firstRoot: Hash, secondRoot: Hash, proof: readonly Hash[]): boolean {
  if (first <= 0 || first > second) return false
  if (first === second) return proof.length === 0 && equal(firstRoot, secondRoot)
  const [head, ...tail] = proof
  if (head === undefined) return false
  const path = isPowerOfTwo(first) ? proof : tail
  let fn = first - 1
  let sn = second - 1
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  let fr = isPowerOfTwo(first) ? firstRoot : head
  let sr = fr
  for (const c of path) {
    if (sn === 0) return false
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr)
      sr = nodeHash(c, sr)
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2)
          sn = Math.floor(sn / 2)
        }
      }
    } else {
      sr = nodeHash(sr, c)
    }
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  return sn === 0 && equal(fr, firstRoot) && equal(sr, secondRoot)
}

export function completedBy(index: number, leaf: Hash, source: SubtreeSource): { level: number; index: number; hash: Hash }[] {
  const out = [{ level: 0, index, hash: leaf }]
  let level = 0
  let position = index
  let hash = leaf
  while (position % 2 === 1) {
    const left = source(level, position - 1)
    hash = nodeHash(left, hash)
    level++
    position = (position - 1) / 2
    out.push({ level, index: position, hash })
  }
  return out
}

export function rootFromLeaves(leaves: readonly Hash[]): Hash {
  if (leaves.length === 0) return sha256(new Uint8Array(0))
  const build = (part: readonly Hash[]): Hash => {
    const [leaf] = part
    if (leaf !== undefined && part.length === 1) return leaf
    const k = largestPowerOfTwoBelow(part.length)
    return nodeHash(build(part.slice(0, k)), build(part.slice(k)))
  }
  return build(leaves)
}
