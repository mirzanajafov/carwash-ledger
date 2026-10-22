import { NO_FAULTS, parseFaultPlan, type FaultPlan } from './faults.ts'

export interface Config {
  port: number
  databaseUrl: string
  apiKey: string
  adminKey: string
  webhook: { url: string; secret: string } | undefined
  authorizationTtlSeconds: number
  idempotencyWindowSeconds: number
  hangMs: number
  faultPlan: FaultPlan
  settlementDaySeconds: number
  feeBps: number
  feeFixed: number
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

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const url = env.PSP_WEBHOOK_URL || undefined
  const secret = env.PSP_WEBHOOK_SECRET || undefined
  if (url && !secret) throw new Error('PSP_WEBHOOK_SECRET is required when PSP_WEBHOOK_URL is set')
  return {
    port: integer(env, 'PSP_PORT', 3142),
    databaseUrl: required(env, 'PSP_DATABASE_URL'),
    apiKey: required(env, 'PSP_API_KEY'),
    adminKey: required(env, 'PSP_ADMIN_KEY'),
    webhook: url && secret ? { url, secret } : undefined,
    authorizationTtlSeconds: integer(env, 'PSP_AUTHORIZATION_TTL_SECONDS', 7 * 24 * 3600),
    idempotencyWindowSeconds: integer(env, 'PSP_IDEMPOTENCY_WINDOW_SECONDS', 24 * 3600),
    hangMs: integer(env, 'PSP_HANG_MS', 10_000),
    faultPlan: env.PSP_FAULT_PLAN ? parseFaultPlan(JSON.parse(env.PSP_FAULT_PLAN)) : NO_FAULTS,
    settlementDaySeconds: integer(env, 'PSP_SETTLEMENT_DAY_SECONDS', 86_400) || 86_400,
    feeBps: integer(env, 'PSP_FEE_BPS', 120),
    feeFixed: integer(env, 'PSP_FEE_FIXED', 8),
  }
}
