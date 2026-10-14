import 'server-only'

export function apiUrl(): string {
  return (process.env.API_URL ?? 'http://127.0.0.1:3140').replace(/\/+$/, '')
}
