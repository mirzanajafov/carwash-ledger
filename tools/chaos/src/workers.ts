import { fork, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { EntrySpec, FromWorker, Outcome, ToWorker } from './messages.ts'
import type { WorkerKind } from './plan.ts'

export interface WorkerEvents {
  outcome(ref: string, outcome: Outcome): void
  failpoint(name: string): void
  message(message: FromWorker): void
  log(line: string): void
  exit(worker: Worker, code: number | null, signal: NodeJS.Signals | null): void
}

export class Worker {
  readonly kind: WorkerKind
  readonly index: number
  readonly #script: string
  readonly #env: NodeJS.ProcessEnv
  readonly #events: WorkerEvents
  readonly #inFlight = new Map<number, string>()
  #child: ChildProcess | undefined
  #nextId = 1
  starts = 0

  constructor(kind: WorkerKind, index: number, script: string, env: NodeJS.ProcessEnv, events: WorkerEvents) {
    this.kind = kind
    this.index = index
    this.#script = script
    this.#env = { ...env }
    this.#events = events
  }

  get alive(): boolean {
    return this.#child !== undefined
  }

  get load(): number {
    return this.#inFlight.size
  }

  start(): void {
    if (this.#child !== undefined) return
    this.starts++
    const child = fork(this.#script, [], {
      execArgv: ['--conditions=source'],
      env: { ...process.env, ...this.#env },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    this.#child = child
    child.on('error', (error) => this.#events.log(`${this.kind}-${this.index}: ${error.message}`))
    createInterface({ input: child.stderr! }).on('line', (line) => {
      const hit = /^failpoint (\S+)$/.exec(line)
      if (hit) this.#events.failpoint(hit[1]!)
      else this.#events.log(`${this.kind}-${this.index}: ${line}`)
    })
    child.on('message', (message: FromWorker) => {
      if (message.type === 'outcome') {
        const ref = this.#inFlight.get(message.id)
        if (ref === undefined) return
        this.#inFlight.delete(message.id)
        this.#events.outcome(ref, message.outcome)
      } else {
        this.#events.message(message)
      }
    })
    child.once('exit', (code, signal) => {
      this.#child = undefined
      const lost = [...this.#inFlight.values()]
      this.#inFlight.clear()
      for (const ref of lost) this.#events.outcome(ref, { kind: 'retryable', error: 'worker died' })
      this.#events.exit(this, code, signal)
    })
  }

  post(ref: string, entries: EntrySpec[], reversesId: string | undefined): void {
    const id = this.#nextId++
    this.#inFlight.set(id, ref)
    if (!this.#send({ type: 'post', id, ref, entries, reversesId })) {
      this.#inFlight.delete(id)
      queueMicrotask(() => this.#events.outcome(ref, { kind: 'retryable', error: 'worker unreachable' }))
    }
  }

  disarm(): void {
    this.#env.CHAOS_FAILPOINTS = ''
    this.#send({ type: 'disarm' })
  }

  kill(): void {
    this.#child?.kill('SIGKILL')
  }

  async stop(): Promise<void> {
    const child = this.#child
    if (child === undefined) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exited
  }

  #send(message: ToWorker): boolean {
    const child = this.#child
    if (child === undefined || !child.connected) return false
    try {
      child.send(message)
      return true
    } catch {
      return false
    }
  }
}
