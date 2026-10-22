import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.ts'
import { DashboardController } from './dashboard.controller.ts'
import { SessionsController } from './sessions.controller.ts'

@Module({ imports: [AuditModule], controllers: [DashboardController, SessionsController] })
export class DashboardModule {}
