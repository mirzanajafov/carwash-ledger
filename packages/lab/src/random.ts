export type Random = () => number

export function mulberry32(seed: number): Random {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function exponential(random: Random, meanMs: number): number {
  return -Math.log(1 - random()) * meanMs
}

export function between(random: Random, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1))
}

export function pick<T>(random: Random, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)]
  if (item === undefined) throw new Error('cannot pick from an empty list')
  return item
}
