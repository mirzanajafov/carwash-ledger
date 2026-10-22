import { Module } from '@nestjs/common'
import { WebhooksController } from './webhooks.controller.ts'
import { WebhooksModule } from './webhooks.module.ts'

@Module({ imports: [WebhooksModule], controllers: [WebhooksController] })
export class WebhooksApiModule {}
