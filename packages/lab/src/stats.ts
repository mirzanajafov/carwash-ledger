export function percentile(sorted: ArrayLike<number>, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN
}

export function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

export function distribution(xs: readonly number[]): { n: number; p50: number; p99: number; max: number } {
  const sorted = Float64Array.from(xs).sort()
  return { n: sorted.length, p50: percentile(sorted, 50), p99: percentile(sorted, 99), max: sorted.at(-1) ?? Number.NaN }
}

export function tenths(x: number): number {
  return Math.round(x * 10) / 10
}
