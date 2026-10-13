import { setTimeout as sleep } from 'node:timers/promises'
import type { ToxicKind } from './plan.ts'
import type { LocalKafka } from './kafka.ts'
import type { LocalPostgres } from './postgres.ts'
import type { Random } from './random.ts'
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

export async function holdToxic(
  toxiproxy: Toxiproxy,
  proxy: string,
  toxic: ToxicKind,
  lastsMs: number,
  name: string,
  random: Random,
): Promise<void> {
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
