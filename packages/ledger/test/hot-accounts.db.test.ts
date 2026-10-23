import { checkLedger, violations } from '@carwash/invariants'
import { RetriesExhaustedError } from '@carwash/pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BALANCE_MODES, readBalance, takeSnapshots } from '../src/index.ts'
import { capture, createModeAccounts, inParallel, openLedger, type LedgerFixture } from './support.ts'

let ledger: LedgerFixture

const cleanup = new AsyncDisposableStack()

beforeAll(async () => {
  ledger = await openLedger(16)
  cleanup.defer(() => ledger.close())
})

afterAll(() => cleanup.disposeAsync())

describe('concurrent captures on the hot accounts', () => {
  const journals = 120
  const gross = 1500n
  const fee = 40n

  for (const mode of BALANCE_MODES) {
    it(`keeps ${mode} balances exact`, async () => {
      const { poster } = ledger
      const accounts = await createModeAccounts(ledger.app, mode, { prefix: `${poster.name}:` })
      const refs = Array.from({ length: journals }, (_, i) => `${poster.name}:${mode}:${i}`)
      const gaveUp: string[] = []
      await inParallel(refs, 16, async (ref) => {
        const merchant = Number(ref.split(':').at(-1))
        try {
          await poster.post({ externalRef: ref, entries: capture(accounts, merchant, gross, fee) })
        } catch (error) {
          if (!(error instanceof RetriesExhaustedError)) throw error
          gaveUp.push(ref)
        }
      })
      if (mode !== 'serializable') expect(gaveUp).toEqual([])
      if (mode === 'derived') await takeSnapshots(ledger.app)

      const posted = BigInt(journals - gaveUp.length)
      expect(await readBalance(ledger.app, accounts.receivable)).toBe(gross * posted)
      expect(await readBalance(ledger.app, accounts.fees)).toBe(-fee * posted)
      const merchantTotal = (await Promise.all(accounts.merchants.map((m) => readBalance(ledger.app, m)))).reduce((sum, b) => sum + b, 0n)
      expect(merchantTotal).toBe(-(gross - fee) * posted)
      const leftovers = await ledger.app.query('SELECT 1 FROM journals WHERE external_ref = ANY($1)', [gaveUp])
      expect(leftovers.rowCount).toBe(0)
      expect(violations(await checkLedger(ledger.db.pool('ledger_audit', 1)))).toEqual([])
    })
  }
})
