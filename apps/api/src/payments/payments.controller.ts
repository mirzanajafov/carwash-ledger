import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseInterceptors } from '@nestjs/common'
import type { AuthedRequest } from '../auth/access.guard.ts'
import { CaptureBody, CreatePaymentBody, RefundBody } from '../http/dto.ts'
import { IdempotencyInterceptor, Owned } from '../idempotency/idempotency.interceptor.ts'
import type { Final, OwnedKey } from '../idempotency/idempotency.service.ts'
import { PaymentsService } from './payments.service.ts'

@Controller('v1/payments')
export class PaymentsController {
  readonly #payments: PaymentsService

  constructor(payments: PaymentsService) {
    this.#payments = payments
  }

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  create(@Owned() owned: OwnedKey, @Body() body: CreatePaymentBody): Promise<Final> {
    return this.#payments.create(owned, body)
  }

  @Post(':id/capture')
  @UseInterceptors(IdempotencyInterceptor)
  capture(@Req() request: AuthedRequest, @Owned() owned: OwnedKey, @Param('id', ParseUUIDPipe) id: string, @Body() body: CaptureBody): Promise<Final> {
    return this.#payments.capture(owned, request.client, id, body.amount)
  }

  @Post(':id/cancel')
  @UseInterceptors(IdempotencyInterceptor)
  cancel(@Req() request: AuthedRequest, @Owned() owned: OwnedKey, @Param('id', ParseUUIDPipe) id: string): Promise<Final> {
    return this.#payments.cancel(owned, request.client, id)
  }

  @Post(':id/refunds')
  @UseInterceptors(IdempotencyInterceptor)
  refund(@Req() request: AuthedRequest, @Owned() owned: OwnedKey, @Param('id', ParseUUIDPipe) id: string, @Body() body: RefundBody): Promise<Final> {
    return this.#payments.refund(owned, request.client, id, body.amount)
  }

  @Get(':id')
  get(@Req() request: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.#payments.get(request.client, id)
  }
}
