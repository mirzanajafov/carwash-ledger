import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common'
import type { Response } from 'express'
import type { AuthedRequest } from '../auth/access.guard.ts'
import { CaptureBody, CreatePaymentBody, RefundBody } from '../http/dto.ts'
import { IdempotencyService } from '../idempotency/idempotency.service.ts'
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
  create(@Req() request: AuthedRequest, @Res() response: Response, @Body() body: CreatePaymentBody): Promise<void> {
    return this.#idempotency.run(request, response, (owned) =>
      this.#payments.create(owned, {
        amount: body.amount,
        currency: body.currency,
        merchant: body.merchant,
        token: body.token,
        capture: body.capture ?? 'auto',
      }),
    )
  }

  @Post(':id/capture')
  capture(@Req() request: AuthedRequest, @Res() response: Response, @Param('id', ParseUUIDPipe) id: string, @Body() body: CaptureBody): Promise<void> {
    return this.#idempotency.run(request, response, (owned) => this.#payments.capture(owned, request.client, id, body.amount))
  }

  @Post(':id/cancel')
  cancel(@Req() request: AuthedRequest, @Res() response: Response, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.#idempotency.run(request, response, (owned) => this.#payments.cancel(owned, request.client, id))
  }

  @Post(':id/refunds')
  refund(@Req() request: AuthedRequest, @Res() response: Response, @Param('id', ParseUUIDPipe) id: string, @Body() body: RefundBody): Promise<void> {
    return this.#idempotency.run(request, response, (owned) => this.#payments.refund(owned, request.client, id, body.amount))
  }

  @Get(':id')
  get(@Req() request: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.#payments.get(request.client, id)
  }
}
