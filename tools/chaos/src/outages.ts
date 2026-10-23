import { setTimeout as sleep } from 'node:timers/promises'
import { mulberry32, type Random } from '@carwash/lab'
import type { Lab } from './lab.ts'
import type { ToxicKind } from './plan.ts'
import { toxicFor, type Toxiproxy } from './toxiproxy.ts'

interface Crashable {
  kill(): Promise<void>
  start(): void
  waitReady(): Promise<number>
}

async function crash(target: Crashable, downMs: number): Promise<number> {
  await target.kill()
  await sleep(downMs)
  target.start()
  return Math.round(await target.waitReady())
}

async function hold(toxiproxy: Toxiproxy, proxy: string, toxic: ToxicKind, lastsMs: number, name: string, random: Random): Promise<void> {
  if (toxic === 'down') {
    await toxiproxy.setEnabled(proxy, false)
    await sleep(lastsMs)
    await toxiproxy.setEnabled(proxy, true)
    return
  }
  await toxiproxy.addToxic(proxy, toxicFor(toxic, name, random))
  await sleep(lastsMs)
  await toxiproxy.removeToxic(proxy, name)
}

export interface Outage {
  kills: number
  recoveryMs: number[]
}

export class Outages {
  readonly #lab: Lab
  readonly #seed: number
  readonly #log: (line: string) => void
  readonly #busy = new Set<'postgres' | 'kafka'>()
  readonly #crashed = new Set<'postgres' | 'kafka'>()
  readonly #faults: Promise<void>[] = []
  #toxics = 0

  constructor(lab: Lab, seed: number, log: (line: string) => void) {
    this.#lab = lab
    this.#seed = seed
    this.#log = log
  }

  get postgresUp(): boolean {
    return this.#lab.postgres.running && !this.#busy.has('postgres')
  }

  track(fault: Promise<void>): void {
    this.#faults.push(fault)
  }

  async end(): Promise<void> {
    await Promise.all(this.#faults)
    await this.#lab.toxiproxy.reset()
    if (!this.#lab.postgres.running) {
      this.#lab.postgres.start()
      await this.#lab.postgres.waitReady()
    }
    if (this.#crashed.has('kafka') && !this.#lab.kafka.running) {
      this.#lab.kafka.start()
      await this.#lab.kafka.waitReady()
    }
  }

  crashPostgres(downMs: number, outage: Outage): Promise<void> {
    return this.#exclusively('postgres', downMs, outage, this.#lab.postgres)
  }

  crashKafka(downMs: number, outage: Outage): Promise<void> {
    return this.#exclusively('kafka', downMs, outage, this.#lab.kafka)
  }

  holdToxic(proxy: string, toxic: ToxicKind, lastsMs: number, index: number): Promise<void> {
    this.#log(`toxic ${toxic} on ${proxy} for ${lastsMs} ms`)
    return hold(this.#lab.toxiproxy, proxy, toxic, lastsMs, `${toxic}-${this.#toxics++}`, mulberry32(this.#seed * 7919 + index))
  }

  async #exclusively(name: 'postgres' | 'kafka', downMs: number, outage: Outage, target: Crashable): Promise<void> {
    if (this.#busy.has(name)) return
    this.#busy.add(name)
    this.#crashed.add(name)
    try {
      outage.kills++
      this.#log(`${name} crash, down for ${downMs} ms`)
      outage.recoveryMs.push(await crash(target, downMs))
      this.#log(`${name} back after ${String(outage.recoveryMs.at(-1))} ms`)
    } finally {
      this.#busy.delete(name)
    }
  }
}
