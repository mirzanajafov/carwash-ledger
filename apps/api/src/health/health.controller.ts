import { Controller, Get } from '@nestjs/common'
import type { HealthView } from '@carwash/contracts'
import { Public } from '../auth/access.guard.ts'
import { Database } from '../db/database.ts'
import { INSTANCE } from '../http/instance.ts'

@Public()
@Controller('health')
export class HealthController {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  @Get()
  async check(): Promise<HealthView> {
    await this.#db.pool.query('SELECT 1')
    return { ok: true, ...INSTANCE }
  }
}
