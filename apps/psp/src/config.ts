import { nonNegativeInteger, optional, positiveInteger, required } from '@carwash/env'
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

function faultPlan(json: string | undefined): FaultPlan {
  if (json === undefined) return NO_FAULTS
  const plan = FaultPlanInput.safeParse(JSON.parse(json))
  if (!plan.success) throw new Error(`PSP_FAULT_PLAN: ${plan.error.issues[0]?.message ?? 'not a fault plan'}`)
  return plan.data
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const url = optional(env, 'PSP_WEBHOOK_URL')
  const secret = optional(env, 'PSP_WEBHOOK_SECRET')
  if (url && !secret) throw new Error('PSP_WEBHOOK_SECRET is required when PSP_WEBHOOK_URL is set')
  return {
    port: nonNegativeInteger(env, 'PSP_PORT', 3142),
    databaseUrl: required(env, 'PSP_DATABASE_URL'),
    apiKey: required(env, 'PSP_API_KEY'),
    adminKey: required(env, 'PSP_ADMIN_KEY'),
    webhook: url && secret ? { url, secret } : undefined,
    authorizationTtlSeconds: nonNegativeInteger(env, 'PSP_AUTHORIZATION_TTL_SECONDS', 7 * 24 * 3600),
    idempotencyWindowSeconds: nonNegativeInteger(env, 'PSP_IDEMPOTENCY_WINDOW_SECONDS', 24 * 3600),
    hangMs: nonNegativeInteger(env, 'PSP_HANG_MS', 10_000),
    faultPlan: faultPlan(optional(env, 'PSP_FAULT_PLAN')),
    settlementDaySeconds: positiveInteger(env, 'PSP_SETTLEMENT_DAY_SECONDS', 86_400),
    feeBps: nonNegativeInteger(env, 'PSP_FEE_BPS', 120),
    feeFixed: nonNegativeInteger(env, 'PSP_FEE_FIXED', 8),
  }
}
