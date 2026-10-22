import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseInterceptors } from '@nestjs/common'
import type { AuthedRequest } from '../auth/access.guard.ts'
import { CaptureBody, CreatePaymentBody, RefundBody } from '../http/dto.ts'
import { IdempotencyService, type KeyedRequest, type Reply } from '../idempotency/idempotency.service.ts'
import { Keyed } from '../idempotency/keyed.decorator.ts'
import { ReplyInterceptor } from '../idempotency/reply.interceptor.ts'
import { PaymentsService } from './payments.service.ts'

@Controller('v1/payments')
export class PaymentsController {
  readonly #payments: PaymentsService
  readonly #idempotency: IdempotencyService

  constructor(payments: PaymentsService, idempotency: IdempotencyService) {
    this.#payments = payments
    this.#idempotency = idempotency
  }

  @Post()
  @UseInterceptors(ReplyInterceptor)
  create(@Keyed() keyed: KeyedRequest, @Body() body: CreatePaymentBody): Promise<Reply> {
    return this.#idempotency.run(keyed, (owned) => this.#payments.create(owned, body))
  }

  @Post(':id/capture')
  @UseInterceptors(ReplyInterceptor)
  capture(@Req() request: AuthedRequest, @Keyed() keyed: KeyedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: CaptureBody): Promise<Reply> {
    return this.#idempotency.run(keyed, (owned) => this.#payments.capture(owned, request.client, id, body.amount))
  }

  @Post(':id/cancel')
  @UseInterceptors(ReplyInterceptor)
  cancel(@Req() request: AuthedRequest, @Keyed() keyed: KeyedRequest, @Param('id', ParseUUIDPipe) id: string): Promise<Reply> {
    return this.#idempotency.run(keyed, (owned) => this.#payments.cancel(owned, request.client, id))
  }

  @Post(':id/refunds')
  @UseInterceptors(ReplyInterceptor)
  refund(@Req() request: AuthedRequest, @Keyed() keyed: KeyedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: RefundBody): Promise<Reply> {
    return this.#idempotency.run(keyed, (owned) => this.#payments.refund(owned, request.client, id, body.amount))
  }

  @Get(':id')
  get(@Req() request: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.#payments.get(request.client, id)
  }
}
