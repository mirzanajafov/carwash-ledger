import { Body, Controller, Get, Param, Post, UseInterceptors } from '@nestjs/common'
import { AdminOnly } from '../auth/access.guard.ts'
import { MerchantBody } from '../http/dto.ts'
import { IdempotencyInterceptor, Owned } from '../idempotency/idempotency.interceptor.ts'
import type { Final, OwnedKey } from '../idempotency/idempotency.service.ts'
import { MerchantsService } from './merchants.service.ts'

@AdminOnly()
@Controller('v1/merchants')
export class MerchantsController {
  readonly #merchants: MerchantsService

  constructor(merchants: MerchantsService) {
    this.#merchants = merchants
  }

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  create(@Owned() owned: OwnedKey, @Body() body: MerchantBody): Promise<Final> {
    return this.#merchants.create(owned, body)
  }

  @Get(':code')
  get(@Param('code') code: string) {
    return this.#merchants.get(code)
  }
}
