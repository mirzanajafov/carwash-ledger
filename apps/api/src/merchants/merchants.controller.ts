import { Body, Controller, Get, Param, Post, UseInterceptors } from '@nestjs/common'
import { AdminOnly } from '../auth/access.guard.ts'
import { MerchantBody } from '../http/dto.ts'
import { Keyed, ReplyInterceptor } from '../idempotency/idempotency.interceptor.ts'
import { IdempotencyService, type KeyedRequest, type Reply } from '../idempotency/idempotency.service.ts'
import { MerchantsService } from './merchants.service.ts'

@AdminOnly()
@Controller('v1/merchants')
export class MerchantsController {
  readonly #merchants: MerchantsService
  readonly #idempotency: IdempotencyService

  constructor(merchants: MerchantsService, idempotency: IdempotencyService) {
    this.#merchants = merchants
    this.#idempotency = idempotency
  }

  @Post()
  @UseInterceptors(ReplyInterceptor)
  create(@Keyed() keyed: KeyedRequest, @Body() body: MerchantBody): Promise<Reply> {
    return this.#idempotency.run(keyed, (owned) => this.#merchants.create(owned, body))
  }

  @Get(':code')
  get(@Param('code') code: string) {
    return this.#merchants.get(code)
  }
}
