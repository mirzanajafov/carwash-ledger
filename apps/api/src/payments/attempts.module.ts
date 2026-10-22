import { Module } from '@nestjs/common'
import { LedgerModule } from '../ledger/ledger.module.ts'
import { PspModule } from '../psp/psp.module.ts'
import { AttemptsService } from './attempts.service.ts'

@Module({ imports: [LedgerModule, PspModule], providers: [AttemptsService], exports: [AttemptsService] })
export class AttemptsModule {}
