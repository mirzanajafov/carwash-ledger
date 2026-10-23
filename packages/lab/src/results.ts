import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function toJson(data: unknown, indent?: number): string {
  return JSON.stringify(data, (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), indent)
}

export function createResultsDir(dir: string, suffix = ''): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
  const target = join(dir, suffix === '' ? stamp : `${stamp}-${suffix}`)
  mkdirSync(target, { recursive: true })
  return target
}

export function appendJsonLine(file: string, data: unknown): void {
  appendFileSync(file, toJson(data) + '\n')
}

export function writeJson(file: string, data: unknown): string {
  writeFileSync(file, toJson(data, 2) + '\n')
  return file
}

export function writeResults(dir: string, data: unknown): string {
  return writeJson(join(createResultsDir(dir), 'results.json'), data)
}
