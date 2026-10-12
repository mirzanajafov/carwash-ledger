import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common'
import { findAccounts, readBalance } from '@carwash/ledger'
import type { Response } from 'express'
import { AdminOnly, type AuthedRequest } from '../auth/access.guard.ts'
import { Database } from '../db/database.ts'
import { notFound } from '../http/api-error.ts'
import { MerchantBody, PayoutBody } from '../http/dto.ts'
import { IdempotencyService } from '../idempotency/idempotency.service.ts'
import { PayoutsService } from './payouts.service.ts'

@AdminOnly()
@Controller('v1/merchants')
export class MerchantsController {
  readonly #payouts: PayoutsService
  readonly #idempotency: IdempotencyService

  constructor(payouts: PayoutsService, idempotency: IdempotencyService) {
    this.#payouts = payouts
    this.#idempotency = idempotency
  }

  @Post()
  create(@Req() request: AuthedRequest, @Res() response: Response, @Body() body: MerchantBody): Promise<void> {
    return this.#idempotency.run(request, response, (owned) => this.#payouts.createMerchant(owned, body))
  }

  @Get(':code')
  get(@Param('code') code: string) {
    return this.#payouts.merchant(code)
  }
}

@AdminOnly()
@Controller('v1/payouts')
export class PayoutsController {
  readonly #payouts: PayoutsService
  readonly #idempotency: IdempotencyService

  constructor(payouts: PayoutsService, idempotency: IdempotencyService) {
    this.#payouts = payouts
    this.#idempotency = idempotency
  }

  @Post()
  create(@Req() request: AuthedRequest, @Res() response: Response, @Body() body: PayoutBody): Promise<void> {
    return this.#idempotency.run(request, response, (owned) => this.#payouts.create(owned, body))
  }
}

@Controller('v1/accounts')
export class AccountsController {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  @Get(':code/balance')
  async balance(@Param('code') code: string) {
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
