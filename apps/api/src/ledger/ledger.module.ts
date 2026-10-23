import { Module } from '@nestjs/common'
import { ChartService } from './chart.service.ts'

@Module({ providers: [ChartService], exports: [ChartService] })
export class LedgerModule {}
