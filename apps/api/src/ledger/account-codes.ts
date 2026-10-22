export function merchantAccountCode(merchant: string): string {
  return `merchant_payable:${merchant}`
}
