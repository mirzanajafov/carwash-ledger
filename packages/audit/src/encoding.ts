export const ENCODING_VERSION = 1

export interface CanonicalEntry {
  id: bigint
  accountId: bigint
  amount: bigint
}

export interface CanonicalJournal {
  id: bigint
  externalRef: string
  createdAtMicros: bigint
  entries: readonly CanonicalEntry[]
}

const U64_MAX = (1n << 64n) - 1n
const I64_MIN = -(1n << 63n)
const I64_MAX = (1n << 63n) - 1n

class Writer {
  readonly #chunks: Uint8Array[] = []
  #length = 0

  bytes(value: Uint8Array): void {
    this.#chunks.push(value)
    this.#length += value.length
  }

  u8(value: number): void {
    this.bytes(Uint8Array.of(value))
  }

  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError(`${value} does not fit in 32 bits`)
    const out = new Uint8Array(4)
    new DataView(out.buffer).setUint32(0, value)
    this.bytes(out)
  }

  u64(value: bigint): void {
    if (value < 0n || value > U64_MAX) throw new RangeError(`${value} does not fit in an unsigned 64-bit field`)
    const out = new Uint8Array(8)
    new DataView(out.buffer).setBigUint64(0, value)
    this.bytes(out)
  }

  i64(value: bigint): void {
    if (value < I64_MIN || value > I64_MAX) throw new RangeError(`${value} does not fit in a signed 64-bit field`)
    const out = new Uint8Array(8)
    new DataView(out.buffer).setBigInt64(0, value)
    this.bytes(out)
  }

  text(value: string): void {
    const encoded = new TextEncoder().encode(value)
    this.u32(encoded.length)
    this.bytes(encoded)
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.#length)
    let offset = 0
    for (const chunk of this.#chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}

export function canonicalJournal(journal: CanonicalJournal): Uint8Array {
  const entries = [...journal.entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  let previous: bigint | undefined
  for (const { id } of entries) {
    if (id === previous) throw new Error(`entry ${id} appears twice in journal ${journal.id}`)
    previous = id
  }
  const out = new Writer()
  out.u8(ENCODING_VERSION)
  out.u64(journal.id)
  out.text(journal.externalRef)
  out.i64(journal.createdAtMicros)
  out.u32(entries.length)
  for (const entry of entries) {
    out.u64(entry.id)
    out.u64(entry.accountId)
    out.i64(entry.amount)
  }
  return out.finish()
}
