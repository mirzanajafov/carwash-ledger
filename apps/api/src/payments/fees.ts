export interface FeeSchedule {
  bps: number
  fixed: bigint
}

export function platformFee(amount: bigint, schedule: FeeSchedule): bigint {
  return (amount * BigInt(schedule.bps)) / 10_000n + schedule.fixed
}

export function feeRefund(fee: bigint, captured: bigint, refundedBefore: bigint, refund: bigint): bigint {
  const share = (refunded: bigint) => (fee * refunded) / captured
  return share(refundedBefore + refund) - share(refundedBefore)
}
