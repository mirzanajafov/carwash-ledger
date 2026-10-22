import { Controller, Get } from '@nestjs/common'
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
  async check() {
    await this.#db.pool.query('SELECT 1')
    return { ok: true, ...INSTANCE }
  }
}
