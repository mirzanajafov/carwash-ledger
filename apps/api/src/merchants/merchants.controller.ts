import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common'
import type { Response } from 'express'
import { AdminOnly, type AuthedRequest } from '../auth/access.guard.ts'
import { MerchantBody } from '../http/dto.ts'
import { IdempotencyService } from '../idempotency/idempotency.service.ts'
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
  create(@Req() request: AuthedRequest, @Res() response: Response, @Body() body: MerchantBody): Promise<void> {
    return this.#idempotency.run(request, response, (owned) => this.#merchants.create(owned, body))
  }

  @Get(':code')
  get(@Param('code') code: string) {
    return this.#merchants.get(code)
  }
}
