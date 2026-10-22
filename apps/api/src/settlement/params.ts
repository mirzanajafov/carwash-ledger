import { badRequest } from '../http/api-error.ts'

export function dayNumber(value: string | undefined, name: string): number {
  if (value === undefined || !/^\d{1,12}$/.test(value)) throw badRequest(`${name} must be a day number`)
  return Number(value)
}

export function currencyCode(value: string | undefined): string {
  const currency = value ?? 'EUR'
  if (!/^[A-Z]{3}$/.test(currency)) throw badRequest('currency must be a three-letter code')
  return currency
}
