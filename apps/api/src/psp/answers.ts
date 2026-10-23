import type { PspCall } from './psp.client.ts'

export const CARD_ATTEMPT_KINDS = ['authorize', 'capture', 'cancel'] as const

export type CardAttemptKind = (typeof CARD_ATTEMPT_KINDS)[number]
export type AttemptKind = CardAttemptKind | 'refund' | 'payout'
export type AnswerStatus = 'succeeded' | 'declined'

export interface ExpectedAnswer {
  attemptId: string
  kind: AttemptKind
  amount: bigint
  currency: string
  chargeId: string | null
}

export function expectedFrom(call: PspCall, amount = call.amount): ExpectedAnswer {
  return { attemptId: call.attemptId, kind: call.kind, amount, currency: call.currency, chargeId: 'chargeId' in call ? call.chargeId : null }
}

export interface PspAnswer {
  operationId: string
  status: AnswerStatus
  reason: string | null
  chargeId: string | null
}

export type AnswerCheck = { ok: true; answer: PspAnswer } | { ok: false; problems: string[] }

function minorUnits(value: unknown): unknown {
  return Number.isSafeInteger(value) ? BigInt(value as number) : value
}

function field(source: unknown, name: string): unknown {
  return typeof source === 'object' && source !== null ? (source as Record<string, unknown>)[name] : undefined
}

export function answeredAmount(body: unknown): bigint | undefined {
  const amount = minorUnits(field(body, 'amount'))
  return typeof amount === 'bigint' && amount > 0n ? amount : undefined
}

export function checkAnswer(expected: ExpectedAnswer, body: unknown): AnswerCheck {
  const problems: string[] = []
  const show = (value: unknown) => (typeof value === 'bigint' ? value.toString() : JSON.stringify(value))
  const expect = (name: string, actual: unknown, wanted: unknown) => {
    if (actual !== wanted) problems.push(`${name} is ${show(actual)}, expected ${show(wanted)}`)
  }
  const operationId = field(body, 'id')
  const status = field(body, 'status')
  const reason = field(body, 'reason')
  const charge = field(body, 'charge')
  const chargeId = field(charge, 'id')

  expect('object', field(body, 'object'), 'operation')
  expect('idempotency_key', field(body, 'idempotency_key'), expected.attemptId)
  expect('kind', field(body, 'kind'), expected.kind)
  if (typeof operationId !== 'string' || operationId.length === 0) problems.push('id is missing')
  if (status !== 'succeeded' && status !== 'declined') problems.push(`status is ${JSON.stringify(status)}`)
  if (reason !== null && typeof reason !== 'string') problems.push('reason is not a string')

  const amount = field(body, 'amount')
  expect('amount', minorUnits(amount), expected.amount)
  expect('currency', field(body, 'currency'), expected.currency)

  if (expected.kind === 'authorize') {
    if (status === 'succeeded') {
      if (typeof chargeId !== 'string') problems.push('charge.id is missing')
      const authorized = field(charge, 'authorized_amount')
      expect('charge.authorized_amount', minorUnits(authorized), expected.amount)
    }
  } else if (expected.kind !== 'payout') {
    expect('charge.id', chargeId, expected.chargeId)
  }

  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    answer: {
      operationId: operationId as string,
      status: status as PspAnswer['status'],
      reason: (reason as string | null) ?? null,
      chargeId: typeof chargeId === 'string' ? chargeId : null,
    },
  }
}
