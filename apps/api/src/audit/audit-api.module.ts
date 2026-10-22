import { Module } from '@nestjs/common'
import { AuditController } from './audit.controller.ts'
import { AuditModule } from './audit.module.ts'

@Module({ imports: [AuditModule], controllers: [AuditController] })
export class AuditApiModule {}
