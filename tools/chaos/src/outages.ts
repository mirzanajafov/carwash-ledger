import { setTimeout as sleep } from 'node:timers/promises'
import { mulberry32, type Random } from '@carwash/lab'
import type { Lab } from './lab.ts'
import type { ToxicKind } from './plan.ts'
import type { LocalKafka } from './kafka.ts'
import type { LocalPostgres } from './postgres.ts'
import { toxicFor, type Toxiproxy } from './toxiproxy.ts'

export async function crashPostgres(postgres: LocalPostgres, downMs: number): Promise<number> {
  await postgres.kill()
  await sleep(downMs)
  postgres.start()
  return Math.round(await postgres.waitReady())
}

export async function crashKafka(kafka: LocalKafka, downMs: number): Promise<number> {
  await kafka.kill()
  await sleep(downMs)
  kafka.start()
  return Math.round(await kafka.waitReady())
}

export async function holdToxic(toxiproxy: Toxiproxy, proxy: string, toxic: ToxicKind, lastsMs: number, name: string, random: Random): Promise<void> {
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
  #toxics = 0

  constructor(lab: Lab, seed: number, log: (line: string) => void) {
    this.#lab = lab
    this.#seed = seed
    this.#log = log
  }

  get postgresBusy(): boolean {
    return this.#busy.has('postgres')
  }

  crashPostgres(downMs: number, outage: Outage): Promise<void> {
    return this.#exclusively('postgres', downMs, outage, () => crashPostgres(this.#lab.postgres, downMs))
  }

  crashKafka(downMs: number, outage: Outage): Promise<void> {
    return this.#exclusively('kafka', downMs, outage, () => crashKafka(this.#lab.kafka, downMs))
  }

  holdToxic(proxy: string, toxic: ToxicKind, lastsMs: number, index: number): Promise<void> {
    this.#log(`toxic ${toxic} on ${proxy} for ${lastsMs} ms`)
    return holdToxic(this.#lab.toxiproxy, proxy, toxic, lastsMs, `${toxic}-${this.#toxics++}`, mulberry32(this.#seed * 7919 + index))
  }

  async #exclusively(name: 'postgres' | 'kafka', downMs: number, outage: Outage, crash: () => Promise<number>): Promise<void> {
    if (this.#busy.has(name)) return
    this.#busy.add(name)
    try {
      outage.kills++
      this.#log(`${name} crash, down for ${downMs} ms`)
      outage.recoveryMs.push(await crash())
      this.#log(`${name} back after ${String(outage.recoveryMs.at(-1))} ms`)
    } finally {
      this.#busy.delete(name)
    }
  }
}
