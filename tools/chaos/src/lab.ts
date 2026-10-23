import type { LocalKafka } from './kafka.ts'
import type { LocalPostgres } from './postgres.ts'
import type { Toxiproxy } from './toxiproxy.ts'

export interface Lab {
  dir: string
  postgres: LocalPostgres
  kafka: LocalKafka
  toxiproxy: Toxiproxy
  log(line: string): void
}

export function withPort(url: string, port: number): string {
  const parsed = new URL(url)
  parsed.port = String(port)
  return parsed.toString()
}
