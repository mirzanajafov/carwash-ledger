const formats = new Map<string, Intl.NumberFormat>()

export function money(cents: bigint | number | string, currency = 'EUR'): string {
  let format = formats.get(currency)
  if (!format) {
    format = new Intl.NumberFormat('en-IE', { style: 'currency', currency, minimumFractionDigits: 2 })
    formats.set(currency, format)
  }
  const value = BigInt(cents)
  const negative = value < 0n
  const abs = negative ? -value : value
  const text = format.format(Number(abs / 100n) + Number(abs % 100n) / 100)
  return negative ? `-${text}` : text
}

export function since(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}
