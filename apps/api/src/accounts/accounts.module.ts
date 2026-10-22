import { Module } from '@nestjs/common'
import { AccountsController } from './accounts.controller.ts'

@Module({ controllers: [AccountsController] })
export class AccountsModule {}
