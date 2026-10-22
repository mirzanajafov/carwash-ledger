import { Body, Controller, Post, UseInterceptors } from '@nestjs/common'
import { AdminOnly } from '../auth/access.guard.ts'
import { PayoutBody } from '../http/dto.ts'
import { IdempotencyInterceptor, Owned } from '../idempotency/idempotency.interceptor.ts'
import type { Final, OwnedKey } from '../idempotency/idempotency.service.ts'
import { PayoutsService } from './payouts.service.ts'

@AdminOnly()
@Controller('v1/payouts')
export class PayoutsController {
  readonly #payouts: PayoutsService

  constructor(payouts: PayoutsService) {
    this.#payouts = payouts
  }

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  create(@Owned() owned: OwnedKey, @Body() body: PayoutBody): Promise<Final> {
    return this.#payouts.create(owned, body)
  }
}
