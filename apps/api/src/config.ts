import { list, nonNegativeInteger, oneOf, optional, positiveInteger, required, type Env } from '@carwash/env'
import type { BalanceMode } from '@carwash/ledger'
import { RELAY_DEFAULTS } from '@carwash/outbox'
import { FALLBACKS, type Fallback } from '@carwash/recon'

export const CORE_CONFIG = Symbol('CORE_CONFIG')
export const API_CONFIG = Symbol('API_CONFIG')
export const WORKER_CONFIG = Symbol('WORKER_CONFIG')

const HOT_ACCOUNT_MODES = ['sharded', 'derived', 'locked'] as const satisfies readonly BalanceMode[]

export type HotAccountMode = (typeof HOT_ACCOUNT_MODES)[number]

export interface CoreConfig {
  databaseUrl: string
  poolSize: number
  connectTimeoutMs: number
  transactionTimeoutMs: number
  auditDatabaseUrl: string | undefined
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
  pspFeeBps: number
  pspFeeFixed: bigint
  reconFallback: Fallback
  reconWindowDays: number
  witnessUrl: string | undefined
}

export interface ApiConfig {
  port: number
  rateLimitPerKey: number
  rateLimitPerIp: number
  trustProxy: false | string[]
  webhookSecret: string | undefined
  liveEveryMs: number
  liveMaxConnections: number
  plugEveryMs: number
  checksEveryMs: number
  sessionHours: number
}

export interface WorkerConfig {
  port: number
  recoveryAfterSeconds: number
  recoveryEveryMs: number
  webhookRetentionDays: number
  kafkaBrokers: readonly string[]
  kafkaTopicPrefix: string
  relayWorkers: number
  relayIdleMaxMs: number
  outboxRetentionHours: number
  inboxRetentionDays: number
  settlementEveryMs: number
  auditEveryMs: number
  auditBatch: number
  witnessToken: string | undefined
  witnessTimeoutMs: number
  checkpointEveryMs: number
  checkpointEveryLeaves: number
  verifyEveryMs: number
}

export function loadCoreConfig(env: Env): CoreConfig {
  const currencies = list(env, 'CURRENCIES', 'EUR')
  if (!currencies.every((c) => /^[A-Z]{3}$/.test(c))) throw new Error('CURRENCIES must be a comma-separated list of currency codes')
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    poolSize: nonNegativeInteger(env, 'DATABASE_POOL_SIZE', 10),
    connectTimeoutMs: nonNegativeInteger(env, 'DATABASE_CONNECT_TIMEOUT_MS', 5000),
    transactionTimeoutMs: nonNegativeInteger(env, 'TRANSACTION_TIMEOUT_MS', 10_000),
    auditDatabaseUrl: optional(env, 'AUDIT_DATABASE_URL'),
    pspUrl: required(env, 'PSP_URL'),
    pspApiKey: required(env, 'PSP_API_KEY'),
    pspTimeoutMs: nonNegativeInteger(env, 'PSP_TIMEOUT_MS', 5000),
    currencies,
    hotAccountMode: oneOf(env, 'HOT_ACCOUNT_MODE', HOT_ACCOUNT_MODES, 'sharded'),
    hotAccountShards: nonNegativeInteger(env, 'HOT_ACCOUNT_SHARDS', 16),
    feeBps: nonNegativeInteger(env, 'FEE_BPS', 200),
    feeFixed: BigInt(nonNegativeInteger(env, 'FEE_FIXED', 10)),
    leaseSeconds: nonNegativeInteger(env, 'IDEMPOTENCY_LEASE_SECONDS', 30),
    idempotencyWindowSeconds: nonNegativeInteger(env, 'IDEMPOTENCY_WINDOW_SECONDS', 24 * 3600),
    pspFeeBps: nonNegativeInteger(env, 'PSP_FEE_BPS', 120),
    pspFeeFixed: BigInt(nonNegativeInteger(env, 'PSP_FEE_FIXED', 8)),
    reconFallback: oneOf(env, 'RECON_FALLBACK', FALLBACKS, 'unique'),
    reconWindowDays: nonNegativeInteger(env, 'RECON_WINDOW_DAYS', 7),
    witnessUrl: optional(env, 'WITNESS_URL'),
  }
}

export function loadApiConfig(env: Env): ApiConfig {
  return {
    port: nonNegativeInteger(env, 'PORT', 3140),
    rateLimitPerKey: nonNegativeInteger(env, 'RATE_LIMIT_PER_KEY', 100),
    rateLimitPerIp: nonNegativeInteger(env, 'RATE_LIMIT_PER_IP', 200),
    trustProxy: env.TRUST_PROXY === 'false' ? false : list(env, 'TRUST_PROXY', 'loopback'),
    webhookSecret: optional(env, 'PSP_WEBHOOK_SECRET'),
    liveEveryMs: positiveInteger(env, 'LIVE_EVERY_MS', 1000),
    liveMaxConnections: nonNegativeInteger(env, 'LIVE_MAX_CONNECTIONS', 100),
    plugEveryMs: nonNegativeInteger(env, 'PLUG_EVERY_MS', 60_000),
    checksEveryMs: nonNegativeInteger(env, 'CHECKS_EVERY_MS', 10_000),
    sessionHours: positiveInteger(env, 'SESSION_HOURS', 12),
  }
}

export function loadWorkerConfig(env: Env): WorkerConfig {
  return {
    port: nonNegativeInteger(env, 'WORKER_PORT', 3144),
    recoveryAfterSeconds: nonNegativeInteger(env, 'RECOVERY_AFTER_SECONDS', 30),
    recoveryEveryMs: nonNegativeInteger(env, 'RECOVERY_EVERY_MS', 5000),
    webhookRetentionDays: nonNegativeInteger(env, 'WEBHOOK_RETENTION_DAYS', 7),
    kafkaBrokers: list(env, 'KAFKA_BROKERS', ''),
    kafkaTopicPrefix: env.KAFKA_TOPIC_PREFIX ?? '',
    relayWorkers: nonNegativeInteger(env, 'RELAY_WORKERS', RELAY_DEFAULTS.workers),
    relayIdleMaxMs: positiveInteger(env, 'RELAY_IDLE_MAX_MS', RELAY_DEFAULTS.idleMaxMs),
    outboxRetentionHours: nonNegativeInteger(env, 'OUTBOX_RETENTION_HOURS', 24),
    inboxRetentionDays: nonNegativeInteger(env, 'INBOX_RETENTION_DAYS', 7),
    settlementEveryMs: nonNegativeInteger(env, 'SETTLEMENT_EVERY_MS', 60_000),
    auditEveryMs: nonNegativeInteger(env, 'AUDIT_EVERY_MS', 1000),
    auditBatch: positiveInteger(env, 'AUDIT_BATCH', 1000),
    witnessToken: optional(env, 'WITNESS_TOKEN'),
    witnessTimeoutMs: nonNegativeInteger(env, 'WITNESS_TIMEOUT_MS', 5000),
    checkpointEveryMs: nonNegativeInteger(env, 'CHECKPOINT_EVERY_MS', 10_000),
    checkpointEveryLeaves: positiveInteger(env, 'CHECKPOINT_EVERY_LEAVES', 10_000),
    verifyEveryMs: nonNegativeInteger(env, 'VERIFY_EVERY_MS', 1000),
  }
}
