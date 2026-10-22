import { Module } from '@nestjs/common'
import { PspClient } from './psp.client.ts'

@Module({ providers: [PspClient], exports: [PspClient] })
export class PspModule {}
