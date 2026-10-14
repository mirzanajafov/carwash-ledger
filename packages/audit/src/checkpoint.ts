export const ORIGIN = 'carwash-ledger'

export interface Checkpoint {
  size: number
  root: string
}

export function checkpointBody(checkpoint: Checkpoint, origin = ORIGIN): string {
  if (!Number.isSafeInteger(checkpoint.size) || checkpoint.size < 0) throw new RangeError('a checkpoint size is a non-negative integer')
  if (!/^[0-9a-f]{64}$/.test(checkpoint.root)) throw new Error('a checkpoint root is 32 bytes of lowercase hex')
  return `${origin}\n${checkpoint.size}\n${checkpoint.root}\n`
}
