import { Module } from '@nestjs/common'
import { Chart } from './chart.service.ts'

@Module({ providers: [Chart], exports: [Chart] })
export class LedgerModule {}
