import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex, nodeHash, toHex, type Hash } from './tree.ts'

export interface FrontierState {
  size: number
  edge: string[]
}

function completeSubtrees(size: number): number {
  let count = 0
  for (let n = size; n > 0; n = Math.floor(n / 2)) count += n % 2
  return count
}

export class Frontier {
  #size: number
  readonly #edge: Hash[]

  constructor(size = 0, edge: readonly Hash[] = []) {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('a tree size is a non-negative integer')
    if (edge.length !== completeSubtrees(size))
      throw new Error(`a tree of ${size} leaves has ${completeSubtrees(size)} complete subtrees on its right edge, not ${edge.length}`)
    this.#size = size
    this.#edge = edge.map((hash) => Uint8Array.from(hash))
  }

  static from(state: FrontierState): Frontier {
    return new Frontier(state.size, state.edge.map(fromHex))
  }

  get size(): number {
    return this.#size
  }

  push(leaf: Hash): void {
    let hash = leaf
    for (let position = this.#size; position % 2 === 1; position = (position - 1) / 2) {
      const left = this.#edge.pop()
      if (left === undefined) throw new Error(`the frontier at size ${this.#size} is missing a subtree on its edge`)
      hash = nodeHash(left, hash)
    }
    this.#edge.push(hash)
    this.#size++
  }

  root(): Hash {
    if (this.#size === 0) return sha256(new Uint8Array(0))
    return this.#edge.reduceRight((right, left) => nodeHash(left, right))
  }

  toJSON(): FrontierState {
    return { size: this.#size, edge: this.#edge.map(toHex) }
  }
}
