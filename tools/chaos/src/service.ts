import { fork, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

export type ExitKind = 'killed' | 'failpoint' | 'boot' | 'crash' | 'stopped'

export interface ServiceEvents {
  failpoint(service: Service, name: string): void
  log(line: string): void
  exit(service: Service, kind: ExitKind, detail: string): void
}

const ENTRY = fileURLToPath(new URL('./service-entry.ts', import.meta.url))

export class Service {
  readonly name: string
  readonly #env: NodeJS.ProcessEnv
  readonly #logFile: string
  readonly #events: ServiceEvents
  #child: ChildProcess | undefined
  #ready = false
  #wasReady = false
  #killed = false
  #failpoint = false
  #stopping = false
  starts = 0

  constructor(name: string, entry: string, env: NodeJS.ProcessEnv, logFile: string, events: ServiceEvents) {
    this.name = name
    this.#env = { ...env, CHAOS_ENTRY: entry }
    this.#logFile = logFile
    this.#events = events
  }

  get alive(): boolean {
    return this.#child !== undefined
  }

  get ready(): boolean {
    return this.#ready
  }

  start(): void {
    if (this.#child !== undefined) return
    this.starts++
    this.#ready = false
    this.#wasReady = false
    this.#killed = false
    this.#failpoint = false
    this.#stopping = false
    const log = openSync(this.#logFile, 'a')
    const child = fork(ENTRY, [], {
      execArgv: [],
      env: { ...process.env, ...this.#env },
      stdio: ['ignore', log, log, 'ipc', 'pipe'],
    })
    closeSync(log)
    this.#child = child
    child.on('error', (error) => this.#events.log(`${this.name}: ${error.message}`))
    createInterface({ input: child.stdio[4] as Readable }).on('line', (line) => {
      const name = /^failpoint (\S+)$/.exec(line)?.[1]
      if (name === undefined) return
      this.#failpoint = true
      this.#events.failpoint(this, name)
    })
    child.on('message', (message: { type?: string }) => {
      if (message.type !== 'ready' || this.#child !== child) return
      this.#ready = true
      this.#wasReady = true
    })
    child.once('exit', () => {
      this.#ready = false
    })
    child.once('close', (code, signal) => {
      this.#child = undefined
      let kind: ExitKind = 'crash'
      if (this.#stopping) kind = 'stopped'
      else if (this.#failpoint) kind = 'failpoint'
      else if (this.#killed) kind = 'killed'
      else if (!this.#wasReady) kind = 'boot'
      this.#events.exit(this, kind, `code ${code} signal ${signal}`)
    })
  }

  kill(): boolean {
    if (this.#child === undefined) return false
    this.#killed = true
    this.#child.kill('SIGKILL')
    return true
  }

  disarm(): void {
    this.#env.CHAOS_FAILPOINTS = ''
    const child = this.#child
    if (!child?.connected) return
    try {
      child.send({ type: 'disarm' })
    } catch {
      return
    }
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    const child = this.#child
    if (child === undefined) return
    this.#stopping = true
    const closed = new Promise((resolve) => child.once('close', resolve))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    await closed
    clearTimeout(timer)
  }
}
