import { Module } from '@nestjs/common'
import { IdempotencyService } from './idempotency.service.ts'

@Module({ providers: [IdempotencyService], exports: [IdempotencyService] })
export class IdempotencyModule {}
