import { Body, Controller, Post, Req, Res } from '@nestjs/common'
import type { Response } from 'express'
import { AdminOnly, type AuthedRequest } from '../auth/access.guard.ts'
import { PayoutBody } from '../http/dto.ts'
import { IdempotencyService } from '../idempotency/idempotency.service.ts'
import { PayoutsService } from './payouts.service.ts'

@AdminOnly()
@Controller('v1/payouts')
export class PayoutsController {
  readonly #payouts: PayoutsService
  readonly #idempotency: IdempotencyService

  constructor(payouts: PayoutsService, idempotency: IdempotencyService) {
    this.#payouts = payouts
    this.#idempotency = idempotency
  }

  @Post()
  create(@Req() request: AuthedRequest, @Res() response: Response, @Body() body: PayoutBody): Promise<void> {
    return this.#idempotency.run(request, response, (owned) => this.#payouts.create(owned, body))
  }
}
