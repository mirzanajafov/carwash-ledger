import { Controller, HttpCode, Inject, Post, Req, type RawBodyRequest } from '@nestjs/common'
import type { Request } from 'express'
import { Public } from '../auth/access.guard.ts'
import { API_CONFIG, type ApiConfig } from '../config.ts'
import { ApiError } from '../http/api-error.ts'
import { verifySignature } from './signature.ts'
import { parseEvent, WebhooksService } from './webhooks.service.ts'

@Public()
@Controller('webhooks')
export class WebhooksController {
  readonly #webhooks: WebhooksService
  readonly #config: ApiConfig

  constructor(webhooks: WebhooksService, @Inject(API_CONFIG) config: ApiConfig) {
    this.#webhooks = webhooks
    this.#config = config
  }

  @Post('psp')
  @HttpCode(200)
  async psp(@Req() request: RawBodyRequest<Request>) {
    const secret = this.#config.webhookSecret
    if (!secret) throw new ApiError(503, 'webhooks_disabled', 'no webhook secret is configured')
    const header = request.headers['psp-signature']
    const raw = request.rawBody?.toString('utf8') ?? ''
    if (typeof header !== 'string' || !verifySignature(secret, raw, header, Math.floor(Date.now() / 1000))) {
      throw new ApiError(400, 'invalid_signature', 'the signature is missing, wrong or too old')
    }
    return this.#webhooks.handle(parseEvent(request.body))
  }
}
