export const API_CONFIG = Symbol('API_CONFIG')

export type HotAccountMode = 'sharded' | 'derived' | 'locked'

export interface ApiConfig {
  port: number
  databaseUrl: string
  poolSize: number
  transactionTimeoutMs: number
  pspUrl: string
  pspApiKey: string
  pspTimeoutMs: number
  currencies: readonly string[]
  hotAccountMode: HotAccountMode
  hotAccountShards: number
  feeBps: number
  feeFixed: bigint
  leaseSeconds: number
  idempotencyWindowSeconds: number
  rateLimitPerKey: number
  rateLimitPerIp: number
  trustProxy: string
  webhookSecret: string | undefined
  workerPort: number
  recoveryAfterSeconds: number
  recoveryEveryMs: number
  webhookRetentionDays: number
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const hotAccountMode = env.HOT_ACCOUNT_MODE ?? 'sharded'
  if (hotAccountMode !== 'sharded' && hotAccountMode !== 'derived' && hotAccountMode !== 'locked') {
    throw new Error('HOT_ACCOUNT_MODE must be sharded, derived or locked')
  }
  const currencies = (env.CURRENCIES ?? 'EUR').split(',').map((c) => c.trim())
  if (!currencies.every((c) => /^[A-Z]{3}$/.test(c))) throw new Error('CURRENCIES must be a comma-separated list of currency codes')
  return {
    port: integer(env, 'PORT', 3140),
    databaseUrl: required(env, 'DATABASE_URL'),
    poolSize: integer(env, 'DATABASE_POOL_SIZE', 10),
    transactionTimeoutMs: integer(env, 'TRANSACTION_TIMEOUT_MS', 10_000),
    pspUrl: required(env, 'PSP_URL'),
    pspApiKey: required(env, 'PSP_API_KEY'),
    pspTimeoutMs: integer(env, 'PSP_TIMEOUT_MS', 5000),
    currencies,
    hotAccountMode,
    hotAccountShards: integer(env, 'HOT_ACCOUNT_SHARDS', 16),
    feeBps: integer(env, 'FEE_BPS', 200),
    feeFixed: BigInt(integer(env, 'FEE_FIXED', 10)),
    leaseSeconds: integer(env, 'IDEMPOTENCY_LEASE_SECONDS', 30),
    idempotencyWindowSeconds: integer(env, 'IDEMPOTENCY_WINDOW_SECONDS', 24 * 3600),
    rateLimitPerKey: integer(env, 'RATE_LIMIT_PER_KEY', 100),
    rateLimitPerIp: integer(env, 'RATE_LIMIT_PER_IP', 200),
    trustProxy: env.TRUST_PROXY ?? 'loopback',
    webhookSecret: env.PSP_WEBHOOK_SECRET || undefined,
    workerPort: integer(env, 'WORKER_PORT', 3144),
    recoveryAfterSeconds: integer(env, 'RECOVERY_AFTER_SECONDS', 30),
    recoveryEveryMs: integer(env, 'RECOVERY_EVERY_MS', 5000),
    webhookRetentionDays: integer(env, 'WEBHOOK_RETENTION_DAYS', 7),
  }
}
