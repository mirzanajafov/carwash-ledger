import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common'
import type { AnomalyList, AnomalyView } from '@carwash/contracts'
import { AdminOnly, type AuthedRequest } from '../auth/access.guard.ts'
import { invalidInput } from '../domain-errors.ts'
import type { AnomalyRow } from './anomalies.repository.ts'
import { AnomaliesService, acceptable } from './anomalies.service.ts'

function bankAmount(row: AnomalyRow): string | null {
  const amount = row.details?.answer?.amount
  return Number.isSafeInteger(amount) ? String(amount) : null
}

function view(row: AnomalyRow): AnomalyView {
  return {
    object: 'anomaly',
    id: row.id,
    kind: row.kind,
    created_at: row.created_at.toISOString(),
    problems: row.details?.problems ?? [],
    attempt: row.attempt,
    bank_amount: bankAmount(row),
    payment_id: row.payment_id,
    refund_id: row.refund_id,
    payout_id: row.payout_id,
    merchant: row.merchant,
    acceptable: acceptable(row),
    resolution: row.resolution,
    resolved_at: row.resolved_at?.toISOString() ?? null,
    resolved_by: row.resolver,
  }
}

@AdminOnly()
@Controller('v1/admin/anomalies')
export class AnomaliesController {
  readonly #anomalies: AnomaliesService

  constructor(anomalies: AnomaliesService) {
    this.#anomalies = anomalies
  }

  @Get()
  async list(@Query('state') state = 'open', @Query('limit') limit = '50'): Promise<AnomalyList> {
    if (state !== 'open' && state !== 'resolved') throw invalidInput('state must be open or resolved')
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200)
    const rows = await this.#anomalies.list(state === 'open', n)
    return { object: 'list', data: rows.map(view) }
  }

  @Post(':id/accept')
  @HttpCode(200)
  async accept(@Req() request: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<AnomalyView> {
    return view(await this.#anomalies.accept(id, request.client.id))
  }

  @Post(':id/dispute')
  @HttpCode(200)
  async dispute(@Req() request: AuthedRequest, @Param('id', ParseIntPipe) id: number): Promise<AnomalyView> {
    return view(await this.#anomalies.dispute(id, request.client.id))
  }
}
