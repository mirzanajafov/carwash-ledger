import { createHmac, randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { Random } from '../random.ts'
import type { Endpoints } from './client.ts'

interface Target {
  id: string
  kind: 'capture' | 'payout'
  amount: string
  currency: string
  charge_id: string | null
  merchant: string | null
}

const PENDING = `
  SELECT a.id, a.kind::text AS kind, a.amount::text AS amount, a.currency, p.psp_charge_id AS charge_id, m.code AS merchant
  FROM attempts a
  LEFT JOIN payments p ON p.id = a.payment_id
  LEFT JOIN payouts po ON po.id = a.payout_id
  LEFT JOIN merchants m ON m.id = po.merchant_id
  WHERE a.status = 'pending' AND a.kind IN ('capture', 'payout')
  ORDER BY random()
  LIMIT 1`

export function forgedDecline(target: Target, at: number): string {
  const amount = Number(target.amount)
  const object = {
    id: `op_${randomUUID()}`,
    object: 'operation',
    idempotency_key: target.id,
    kind: target.kind,
    status: 'declined',
    reason: target.kind === 'capture' ? 'authorization_expired' : 'payout_rejected',
    amount,
    currency: target.currency,
    destination: target.kind === 'payout' ? target.merchant : null,
    created: at,
    charge:
      target.kind === 'capture'
        ? {
            id: target.charge_id,
            object: 'charge',
            status: 'authorized',
            currency: target.currency,
            authorized_amount: amount,
            captured_amount: 0,
            refunded_amount: 0,
            expires_at: at,
          }
        : null,
  }
  return JSON.stringify({ id: `evt_${randomUUID()}`, object: 'event', type: 'operation.declined', created: at, data: { object } })
}

export class Forger {
  readonly outcomes: Record<string, number> = {}
  readonly #ledger: pg.Pool
  readonly #endpoints: Endpoints
  readonly #secret: string
  readonly #random: Random

  constructor(ledger: pg.Pool, endpoints: Endpoints, secret: string, random: Random) {
    this.#ledger = ledger
    this.#endpoints = endpoints
    this.#secret = secret
    this.#random = random
  }

  async forge(): Promise<void> {
    this.#count(await this.#forge())
  }

  async #forge(): Promise<string> {
    const live = this.#endpoints.live()
    if (live.length === 0) return 'no api'
    let target: Target | undefined
    try {
      target = (await this.#ledger.query<Target>(PENDING)).rows[0]
    } catch {
      return 'no database'
    }
    if (target === undefined) return 'nothing pending'
    const at = Math.floor(Date.now() / 1000)
    const body = forgedDecline(target, at)
    const signature = `t=${at},v1=${createHmac('sha256', this.#secret).update(`${at}.${body}`).digest('hex')}`
    const api = live[Math.floor(this.#random() * live.length)]
    if (api === undefined) return 'no api'
    try {
      const response = await fetch(`${api}/webhooks/psp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'psp-signature': signature },
        body,
        signal: AbortSignal.timeout(5000),
      })
      const answer = (await response.json().catch(() => null)) as { outcome?: string } | null
      return response.ok ? `${target.kind} ${answer?.outcome ?? 'no outcome'}` : `${target.kind} http ${response.status}`
    } catch {
      return `${target.kind} not delivered`
    }
  }

  #count(outcome: string): void {
    this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1
  }
}
