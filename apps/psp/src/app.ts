import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createPool } from '@carwash/pg'
import type { Config } from './config.ts'
import { WebhookSender } from './delivery.ts'
import { Faults } from './faults.ts'
import { Psp } from './psp.ts'
import { migrate } from './schema.ts'
import { createPspServer } from './server.ts'
import { Settlements } from './settlement.ts'

export interface RunningPsp {
  readonly url: string
  readonly faults: Faults
  readonly psp: Psp
  readonly webhooks: WebhookSender | undefined
  readonly settlements: Settlements
  close(): Promise<void>
}

const SWEEP_EVERY_MS = 60_000

export async function startPsp(config: Config, log?: (message: string) => void): Promise<RunningPsp> {
  const pool = createPool({ connectionString: config.databaseUrl, max: 10 })
  await migrate(pool)
  const faults = new Faults(config.faultPlan)
  const psp = new Psp(pool, faults, {
    authorizationTtlSeconds: config.authorizationTtlSeconds,
    idempotencyWindowSeconds: config.idempotencyWindowSeconds,
    webhooks: config.webhookUrl !== undefined,
  })
  const webhooks =
    config.webhookUrl === undefined
      ? undefined
      : new WebhookSender(pool, { url: config.webhookUrl, secret: config.webhookSecret!, log })
  const settlements = new Settlements(pool, faults, { daySeconds: config.settlementDaySeconds, feeBps: config.feeBps, feeFixed: config.feeFixed })
  const server = createPspServer(psp, faults, settlements, { apiKey: config.apiKey, adminKey: config.adminKey, hangMs: config.hangMs, log })
  server.listen(config.port, '0.0.0.0')
  await once(server, 'listening')
  webhooks?.start()
  const sweeper = setInterval(() => {
    psp.sweepExpiredKeys().catch((error: Error) => log?.(`psp sweeper: ${error.message}`))
  }, SWEEP_EVERY_MS)
  sweeper.unref()

  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    faults,
    psp,
    webhooks,
    settlements,
    async close() {
      clearInterval(sweeper)
      await webhooks?.stop()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await pool.end()
    },
  }
}
