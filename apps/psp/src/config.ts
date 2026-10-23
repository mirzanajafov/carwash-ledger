import { integer, optional, positiveInteger, required } from '@carwash/env'
import { FaultPlanInput, NO_FAULTS, type FaultPlan } from './faults.ts'

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

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const url = optional(env, 'PSP_WEBHOOK_URL')
  const secret = optional(env, 'PSP_WEBHOOK_SECRET')
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
    faultPlan: env.PSP_FAULT_PLAN ? FaultPlanInput.parse(JSON.parse(env.PSP_FAULT_PLAN)) : NO_FAULTS,
    settlementDaySeconds: positiveInteger(env, 'PSP_SETTLEMENT_DAY_SECONDS', 86_400),
    feeBps: integer(env, 'PSP_FEE_BPS', 120),
    feeFixed: integer(env, 'PSP_FEE_FIXED', 8),
  }
}
