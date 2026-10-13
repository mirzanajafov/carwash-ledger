import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export interface KafkaPorts {
  proxied: number
  direct: number
  controller: number
  advertisedProxied: number
}

const BINARY = 'kafka-native'
const LOG4J = '/opt/kafka/log4j2.yaml'
const CLUSTER_ID = 'Y2Fyd2FzaC1jaGFvcy0xMA'

export class LocalKafka {
  readonly #root: string
  readonly #ports: KafkaPorts
  #log = '/dev/null'
  #child: ChildProcess | undefined
  #exited: Promise<void> = Promise.resolve()

  constructor(root: string, ports: KafkaPorts) {
    this.#root = root
    this.#ports = ports
  }

  get running(): boolean {
    return this.#child !== undefined
  }

  get directBroker(): string {
    return `127.0.0.1:${this.#ports.direct}`
  }

  get proxiedUpstream(): number {
    return this.#ports.proxied
  }

  fresh(log: string): void {
    this.#log = log
    rmSync(this.#root, { recursive: true, force: true })
    for (const dir of ['defaults', 'mounted', 'config', 'data']) mkdirSync(join(this.#root, dir), { recursive: true })
    writeFileSync(join(this.#root, 'defaults', 'server.properties'), this.#properties())
    writeFileSync(join(this.#root, 'defaults', 'log4j2.yaml'), readFileSync(LOG4J))
    execFileSync(
      BINARY,
      [
        'setup',
        '--default-configs-dir', join(this.#root, 'defaults'),
        '--mounted-configs-dir', join(this.#root, 'mounted'),
        '--final-configs-dir', join(this.#root, 'config'),
      ],
      { env: { ...process.env, CLUSTER_ID }, stdio: ['ignore', 'ignore', 'inherit'] },
    )
  }

  start(): void {
    if (this.#child !== undefined) return
    const log = openSync(this.#log, 'a')
    const child = spawn(
      BINARY,
      [
        'start',
        '--config', join(this.#root, 'config', 'server.properties'),
        `-Dkafka.logs.dir=${join(this.#root, 'logs')}`,
        `-Dlog4j2.configurationFile=file:${LOG4J}`,
      ],
      { stdio: ['ignore', log, log] },
    )
    this.#child = child
    this.#exited = new Promise((resolve) =>
      child.once('exit', () => {
        if (this.#child === child) this.#child = undefined
        resolve()
      }),
    )
  }

  async waitReady(timeoutMs = 60_000): Promise<number> {
    const started = performance.now()
    const before = this.#started()
    for (;;) {
      if (this.#started() > before) return performance.now() - started
      if (this.#child === undefined) throw new Error('kafka exited while starting')
      if (performance.now() - started > timeoutMs) throw new Error(`kafka did not start in ${timeoutMs} ms`)
      await sleep(50)
    }
  }

  async kill(): Promise<void> {
    const child = this.#child
    if (child === undefined) return
    child.kill('SIGKILL')
    await this.#exited
  }

  async stop(): Promise<void> {
    const child = this.#child
    if (child === undefined) return
    child.kill('SIGTERM')
    const stopped = await Promise.race([this.#exited.then(() => true), sleep(15_000, false)])
    if (!stopped) await this.kill()
  }

  #started(): number {
    try {
      return readFileSync(this.#log, 'utf8').split('Kafka Server started').length - 1
    } catch {
      return 0
    }
  }

  #properties(): string {
    const { proxied, direct, controller, advertisedProxied } = this.#ports
    return [
      'process.roles=broker,controller',
      'node.id=1',
      `controller.quorum.voters=1@127.0.0.1:${controller}`,
      `listeners=PROXIED://127.0.0.1:${proxied},DIRECT://127.0.0.1:${direct},CONTROLLER://127.0.0.1:${controller}`,
      `advertised.listeners=PROXIED://127.0.0.1:${advertisedProxied},DIRECT://127.0.0.1:${direct}`,
      'listener.security.protocol.map=PROXIED:PLAINTEXT,DIRECT:PLAINTEXT,CONTROLLER:PLAINTEXT',
      'inter.broker.listener.name=DIRECT',
      'controller.listener.names=CONTROLLER',
      `log.dirs=${join(this.#root, 'data')}`,
      'num.partitions=8',
      'offsets.topic.replication.factor=1',
      'offsets.topic.num.partitions=8',
      'transaction.state.log.replication.factor=1',
      'transaction.state.log.min.isr=1',
      'group.initial.rebalance.delay.ms=0',
      'auto.create.topics.enable=false',
      'broker.session.timeout.ms=3000',
      'broker.heartbeat.interval.ms=500',
      '',
    ].join('\n')
  }
}
