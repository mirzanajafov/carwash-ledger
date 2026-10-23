import { errorOf, InvariantChecksView, PaymentView, PlugView, type InvariantResult } from '@carwash/contracts'

export const CRASH_POINTS = [
  { failpoint: 'post.after_lock', title: 'Balances locked', detail: 'The balance rows are locked, but the journal is not written yet.' },
  { failpoint: 'attempt.after_psp', title: 'The bank said yes', detail: 'The provider captured the money, but nothing is recorded yet.' },
  { failpoint: 'transaction.before_commit', title: 'Before the first COMMIT', detail: 'The idempotency key is claimed but the claim is not committed yet.' },
  { failpoint: 'transaction.after_commit', title: 'After the first COMMIT', detail: 'The key is claimed and committed, and nothing else has happened.' },
  { failpoint: 'request.before_finish', title: 'Before the key remembers', detail: 'The payment is done, but its idempotency key has not stored the answer.' },
] as const

export type CrashPoint = (typeof CRASH_POINTS)[number]['failpoint']

export type PaymentScope = InvariantChecksView['payment_checks']

export type Step =
  | { kind: 'armed'; at: number; failpoint: string; pid: number; startedAt: string }
  | { kind: 'refused'; at: number; status: number; message: string }
  | { kind: 'sent'; at: number; key: string; amount: number; merchant: string }
  | { kind: 'lost'; at: number; error: string }
  | { kind: 'back'; at: number; pid: number; startedAt: string; downMs: number }
  | { kind: 'retry'; at: number; attempt: number; status: number; code: string; waitMs: number }
  | { kind: 'answered'; at: number; attempt: number; status: number; paymentId: string | null; paymentStatus: string | null }
  | { kind: 'checks'; at: number; ms: number; scope: PaymentScope; results: InvariantResult[] }
  | { kind: 'failed'; at: number; message: string }

export interface Reply {
  status: number
  body: unknown
  retryAfter: number | null
}

export interface PlugDeps {
  arm(failpoint: CrashPoint): Promise<Reply>
  pay(key: string, body: { amount: number; currency: string; merchant: string; token: string }): Promise<Reply>
  health(): Promise<{ pid: number; startedAt: string } | null>
  checks(): Promise<Reply>
  key(): string
  sleep(ms: number): Promise<void>
  now(): number
}

const FINAL = new Set([200, 402])

export async function* pullThePlug(deps: PlugDeps, failpoint: CrashPoint, merchant: string, deadlineMs = 90_000): AsyncGenerator<Step, void> {
  const started = deps.now()
  const at = () => deps.now() - started
  const armed = await deps.arm(failpoint)
  if (armed.status !== 202) {
    yield { kind: 'refused', at: at(), status: armed.status, message: errorOf(armed.body)?.message ?? `the API answered ${armed.status}` }
    return
  }
  const plug = PlugView.parse(armed.body)
  const dead = plug.started_at
  yield { kind: 'armed', at: at(), failpoint, pid: plug.pid, startedAt: dead }

  const key = deps.key()
  const body = { amount: 2400, currency: 'EUR', merchant, token: 'tok_ok' }
  yield { kind: 'sent', at: at(), key, amount: body.amount, merchant }
  let attempt = 1
  let answer: Reply | undefined
  try {
    answer = await deps.pay(key, body)
  } catch (error) {
    const lostAt = at()
    yield { kind: 'lost', at: lostAt, error: error instanceof Error ? error.message : String(error) }
    for (;;) {
      if (at() > deadlineMs) {
        yield { kind: 'failed', at: at(), message: 'the API did not come back in time' }
        return
      }
      const health = await deps.health().catch(() => null)
      if (health && health.startedAt !== dead) {
        yield { kind: 'back', at: at(), pid: health.pid, startedAt: health.startedAt, downMs: at() - lostAt }
        break
      }
      await deps.sleep(200)
    }
  }

  while (!answer || !FINAL.has(answer.status)) {
    if (answer) {
      const waitMs = answer.retryAfter !== null ? answer.retryAfter * 1000 : 500
      yield { kind: 'retry', at: at(), attempt, status: answer.status, code: errorOf(answer.body)?.code ?? '', waitMs }
      await deps.sleep(waitMs)
    }
    if (at() > deadlineMs) {
      yield { kind: 'failed', at: at(), message: 'the payment did not get a final answer in time' }
      return
    }
    attempt++
    answer = await deps.pay(key, body).catch(() => undefined)
    if (!answer) await deps.sleep(500)
  }
  const paid = PaymentView.safeParse(answer.body)
  yield {
    kind: 'answered',
    at: at(),
    attempt,
    status: answer.status,
    paymentId: paid.success ? paid.data.id : null,
    paymentStatus: paid.success ? paid.data.status : null,
  }

  for (;;) {
    const checked = await deps.checks()
    if (checked.status === 200) {
      const checks = InvariantChecksView.parse(checked.body)
      yield { kind: 'checks', at: at(), ms: checks.ms, scope: checks.payment_checks, results: checks.results }
      return
    }
    if (checked.status !== 429 || at() > deadlineMs) {
      yield { kind: 'failed', at: at(), message: errorOf(checked.body)?.message ?? `the checks answered ${checked.status}` }
      return
    }
    await deps.sleep((checked.retryAfter ?? 1) * 1000)
  }
}
