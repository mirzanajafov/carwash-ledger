export interface PspFaults {
  decline: number
  fail: number
  timeoutAfterCommit: number
  slow: number
  wrongAmount: number
  webhook: { duplicate: number; delay: number; reorder: number; drop: number }
}

export interface PaymentsOptions {
  durationMs: number
  rate: number
  clients: number
  merchants: number
  manualShare: number
  cancelShare: number
  partialShare: number
  refundShare: number
  duplicateShare: number
  reuseShare: number
  rivalShare: number
  payoutEveryMs: number
  killEveryMs: number
  postgresEveryMs: number
  kafkaEveryMs: number
  toxicEveryMs: number
  forgeEveryMs: number
  failpointProbability: number
  checkEveryMs: number
  settleMs: number
  leaseSeconds: number
  pspTimeoutMs: number
  psp: PspFaults
}
