import { Module } from '@nestjs/common'
import { AttemptsModule } from '../payments/attempts.module.ts'
import { PspModule } from '../psp/psp.module.ts'
import { WebhooksService } from './webhooks.service.ts'

@Module({ imports: [AttemptsModule, PspModule], providers: [WebhooksService], exports: [WebhooksService] })
export class WebhooksModule {}
