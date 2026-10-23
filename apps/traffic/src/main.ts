import { setTimeout as sleep } from 'node:timers/promises'
import { errorOf, PaymentView, PayoutView } from '@carwash/contracts'
import { nonNegativeInteger, optional, positiveNumber, required } from '@carwash/env'
import { ApiClient } from './client.ts'
import { gapMs, mulberry32, pick, visit, type Visit } from './visits.ts'

const env = process.env
const url = optional(env, 'API_URL') ?? 'http://127.0.0.1:3140'
const clientKey = required(env, 'CLIENT_KEY')
const adminKey = required(env, 'ADMIN_KEY')
const perMinute = positiveNumber(env, 'PER_MINUTE', 12)
const payoutEveryMs = positiveNumber(env, 'PAYOUT_EVERY_MINUTES', 5) * 60_000
const merchants = (optional(env, 'MERCHANTS') ?? 'wash_north:North bay,wash_south:South bay,wash_east:East bay').split(',').map((pair) => {
  const [code = '', name = code] = pair.split(':')
  return { code: code.trim(), name: name.trim() }
})
const random = mulberry32(nonNegativeInteger(env, 'SEED', Date.now() % 2 ** 31))

const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort())
const api = new ApiClient(url, stop.signal)
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`)
const pending = new Set<Promise<void>>()

async function wash(v: Visit, key: string): Promise<void> {
  const created = await api.send(key, 'POST', '/v1/payments', {
    amount: v.amount,
    currency: 'EUR',
    merchant: v.merchant,
    token: v.token,
    capture: v.capture,
  })
  const payment = PaymentView.safeParse(created.body)
  log(`${v.program} at ${v.merchant} for ${v.amount}: ${created.status} ${payment.success ? payment.data.status : (errorOf(created.body)?.code ?? '')}`)
  if (created.status !== 200 || !payment.success) return
  const { id } = payment.data
  if (v.capture === 'manual') {
    await sleep(v.captureAfterMs, undefined, { signal: stop.signal })
    const captured = await api.send(key, 'POST', `/v1/payments/${id}/capture`, {})
    log(`  captured ${id}: ${captured.status}`)
    if (captured.status !== 200) return
  }
  if (v.refund > 0) {
    await sleep(v.refundAfterMs, undefined, { signal: stop.signal })
    const refunded = await api.send(key, 'POST', `/v1/payments/${id}/refunds`, { amount: v.refund })
    log(`  refunded ${v.refund} of ${id}: ${refunded.status}`)
  }
}

function track(task: Promise<void>): void {
  const tracked = task.catch((error: unknown) => {
    if (!stop.signal.aborted) log(`  gave up: ${error instanceof Error ? error.message : String(error)}`)
  })
  pending.add(tracked)
  void tracked.finally(() => pending.delete(tracked))
}

for (const merchant of merchants) {
  const answer = await api.send(adminKey, 'POST', '/v1/merchants', { code: merchant.code, name: merchant.name, currency: 'EUR' }, `merchant:${merchant.code}`)
  if (answer.status !== 200 && answer.status !== 409) throw new Error(`could not set up ${merchant.code}: ${answer.status} ${JSON.stringify(answer.body)}`)
}
log(`washing cars at ${perMinute} a minute across ${merchants.map((m) => m.code).join(', ')}`)

let nextPayout = Date.now() + payoutEveryMs
for (;;) {
  await sleep(gapMs(random, perMinute), undefined, { signal: stop.signal }).catch(() => undefined)
  if (stop.signal.aborted) break
  track(
    wash(
      visit(
        random,
        merchants.map((m) => m.code),
      ),
      clientKey,
    ),
  )
  if (Date.now() >= nextPayout) {
    nextPayout = Date.now() + payoutEveryMs
    const merchant = pick(random, merchants).code
    track(
      api.send(adminKey, 'POST', '/v1/payouts', { merchant, currency: 'EUR' }).then((answer) => {
        const payout = PayoutView.safeParse(answer.body)
        log(`payout to ${merchant}: ${answer.status} ${payout.success ? payout.data.amount : (errorOf(answer.body)?.code ?? '')}`)
      }),
    )
  }
}
await Promise.allSettled(pending)
