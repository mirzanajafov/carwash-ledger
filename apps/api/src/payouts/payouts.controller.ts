import { Body, Controller, Post, UseInterceptors } from '@nestjs/common'
import { AdminOnly } from '../auth/access.guard.ts'
import { PayoutBody } from '../http/dto.ts'
import { IdempotencyService, type KeyedRequest, type Reply } from '../idempotency/idempotency.service.ts'
import { Keyed } from '../idempotency/keyed.decorator.ts'
import { ReplyInterceptor } from '../idempotency/reply.interceptor.ts'
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
  @UseInterceptors(ReplyInterceptor)
  create(@Keyed() keyed: KeyedRequest, @Body() body: PayoutBody): Promise<Reply> {
    return this.#idempotency.run(keyed, (owned) => this.#payouts.create(owned, body))
  }
}
