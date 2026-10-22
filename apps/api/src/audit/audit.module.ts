import { Module } from '@nestjs/common'
import { VerificationRuns } from './verification-runs.ts'

@Module({ providers: [VerificationRuns], exports: [VerificationRuns] })
export class AuditModule {}
