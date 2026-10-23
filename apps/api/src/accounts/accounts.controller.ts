import { Controller, Get, Param } from '@nestjs/common'
import type { BalanceView } from '@carwash/contracts'
import { findAccounts, readBalance } from '@carwash/ledger'
import { Database } from '../db/database.ts'
import { notFound } from '../domain-errors.ts'

@Controller('v1/accounts')
export class AccountsController {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  @Get(':code/balance')
  async balance(@Param('code') code: string): Promise<BalanceView> {
    const account = (await findAccounts(this.#db.pool, [code])).get(code)
    if (!account) throw notFound(`account ${code}`)
    return {
      object: 'balance',
      account: account.code,
      currency: account.currency,
      balance_mode: account.balanceMode,
      balance: Number(await readBalance(this.#db.pool, account)),
    }
  }
}
