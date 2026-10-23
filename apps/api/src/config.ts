import { list, nonNegativeInteger, oneOf, optional, positiveInteger, required, type Env } from '@carwash/env'
import type { BalanceMode } from '@carwash/ledger'
import { RELAY_DEFAULTS } from '@carwash/outbox'
import { FALLBACKS, type Fallback, type FeeContract } from '@carwash/recon'
import { CURRENCY_CODE } from './currency.ts'
import type { FeeSchedule } from './payments/fees.ts'

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
  fees: FeeSchedule
  leaseSeconds: number
  idempotencyWindowSeconds: number
  pspFees: FeeContract
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
  if (currencies.length === 0 || new Set(currencies).size !== currencies.length || !currencies.every((c) => CURRENCY_CODE.test(c))) {
    throw new Error('CURRENCIES must be a comma-separated list of different currency codes')
  }
  const hotAccountShards = positiveInteger(env, 'HOT_ACCOUNT_SHARDS', 16)
  if (hotAccountShards > 256) throw new Error('HOT_ACCOUNT_SHARDS must be at most 256')
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    poolSize: positiveInteger(env, 'DATABASE_POOL_SIZE', 10),
    connectTimeoutMs: positiveInteger(env, 'DATABASE_CONNECT_TIMEOUT_MS', 5000),
    transactionTimeoutMs: positiveInteger(env, 'TRANSACTION_TIMEOUT_MS', 10_000),
    auditDatabaseUrl: optional(env, 'AUDIT_DATABASE_URL'),
    pspUrl: required(env, 'PSP_URL'),
    pspApiKey: required(env, 'PSP_API_KEY'),
    pspTimeoutMs: positiveInteger(env, 'PSP_TIMEOUT_MS', 5000),
    currencies,
    hotAccountMode: oneOf(env, 'HOT_ACCOUNT_MODE', HOT_ACCOUNT_MODES, 'sharded'),
    hotAccountShards,
    fees: { bps: nonNegativeInteger(env, 'FEE_BPS', 200), fixed: BigInt(nonNegativeInteger(env, 'FEE_FIXED', 10)) },
    leaseSeconds: nonNegativeInteger(env, 'IDEMPOTENCY_LEASE_SECONDS', 30),
    idempotencyWindowSeconds: nonNegativeInteger(env, 'IDEMPOTENCY_WINDOW_SECONDS', 24 * 3600),
    pspFees: { bps: BigInt(nonNegativeInteger(env, 'PSP_FEE_BPS', 120)), fixed: BigInt(nonNegativeInteger(env, 'PSP_FEE_FIXED', 8)) },
    reconFallback: oneOf(env, 'RECON_FALLBACK', FALLBACKS, 'unique'),
    reconWindowDays: nonNegativeInteger(env, 'RECON_WINDOW_DAYS', 7),
    witnessUrl: optional(env, 'WITNESS_URL'),
  }
}

export function loadApiConfig(env: Env): ApiConfig {
  const proxies = list(env, 'TRUST_PROXY', 'loopback')
  return {
    port: nonNegativeInteger(env, 'PORT', 3140),
    rateLimitPerKey: positiveInteger(env, 'RATE_LIMIT_PER_KEY', 100),
    rateLimitPerIp: positiveInteger(env, 'RATE_LIMIT_PER_IP', 200),
    trustProxy: proxies.length === 1 && proxies[0] === 'false' ? false : proxies,
    webhookSecret: optional(env, 'PSP_WEBHOOK_SECRET'),
    liveEveryMs: positiveInteger(env, 'LIVE_EVERY_MS', 1000),
    liveMaxConnections: nonNegativeInteger(env, 'LIVE_MAX_CONNECTIONS', 100),
    plugEveryMs: nonNegativeInteger(env, 'PLUG_EVERY_MS', 60_000),
    checksEveryMs: nonNegativeInteger(env, 'CHECKS_EVERY_MS', 10_000),
    sessionHours: positiveInteger(env, 'SESSION_HOURS', 12),
  }
}

export function loadWorkerConfig(env: Env): WorkerConfig {
  const witnessToken = optional(env, 'WITNESS_TOKEN')
  if (optional(env, 'WITNESS_URL') && !witnessToken) throw new Error('WITNESS_TOKEN is required when WITNESS_URL is set')
  return {
    port: nonNegativeInteger(env, 'WORKER_PORT', 3144),
    recoveryAfterSeconds: nonNegativeInteger(env, 'RECOVERY_AFTER_SECONDS', 30),
    recoveryEveryMs: nonNegativeInteger(env, 'RECOVERY_EVERY_MS', 5000),
    webhookRetentionDays: nonNegativeInteger(env, 'WEBHOOK_RETENTION_DAYS', 7),
    kafkaBrokers: list(env, 'KAFKA_BROKERS', ''),
    kafkaTopicPrefix: optional(env, 'KAFKA_TOPIC_PREFIX') ?? '',
    relayWorkers: positiveInteger(env, 'RELAY_WORKERS', RELAY_DEFAULTS.workers),
    relayIdleMaxMs: positiveInteger(env, 'RELAY_IDLE_MAX_MS', RELAY_DEFAULTS.idleMaxMs),
    outboxRetentionHours: nonNegativeInteger(env, 'OUTBOX_RETENTION_HOURS', 24),
    inboxRetentionDays: nonNegativeInteger(env, 'INBOX_RETENTION_DAYS', 7),
    settlementEveryMs: nonNegativeInteger(env, 'SETTLEMENT_EVERY_MS', 60_000),
    auditEveryMs: nonNegativeInteger(env, 'AUDIT_EVERY_MS', 1000),
    auditBatch: positiveInteger(env, 'AUDIT_BATCH', 1000),
    witnessToken,
    witnessTimeoutMs: positiveInteger(env, 'WITNESS_TIMEOUT_MS', 5000),
    checkpointEveryMs: nonNegativeInteger(env, 'CHECKPOINT_EVERY_MS', 10_000),
    checkpointEveryLeaves: positiveInteger(env, 'CHECKPOINT_EVERY_LEAVES', 10_000),
    verifyEveryMs: nonNegativeInteger(env, 'VERIFY_EVERY_MS', 1000),
  }
}
