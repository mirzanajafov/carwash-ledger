import { describe, expect, it } from 'vitest'
import { loadApiConfig, loadCoreConfig, loadWorkerConfig } from '../src/config.ts'

const NEEDED = { DATABASE_URL: 'postgresql://ledger', PSP_URL: 'http://psp', PSP_API_KEY: 'sk_test' }

describe('the settings each process reads', () => {
  it('need the database and the bank, and take defaults for the rest', () => {
    expect(() => loadCoreConfig({ ...NEEDED, PSP_API_KEY: '' })).toThrow('PSP_API_KEY is required')
    expect(loadCoreConfig(NEEDED)).toMatchObject({
      currencies: ['EUR'],
      hotAccountMode: 'sharded',
      feeFixed: 10n,
      reconFallback: 'unique',
      witnessUrl: undefined,
    })
    expect(loadWorkerConfig({})).toMatchObject({ port: 3144, relayWorkers: 4, relayIdleMaxMs: 1000, kafkaBrokers: [] })
    expect(loadApiConfig({})).toMatchObject({ port: 3140, trustProxy: ['loopback'], sessionHours: 12 })
  })

  it('are parsed once, when the process starts', () => {
    expect(loadCoreConfig({ ...NEEDED, CURRENCIES: 'EUR, USD', HOT_ACCOUNT_MODE: 'derived' })).toMatchObject({
      currencies: ['EUR', 'USD'],
      hotAccountMode: 'derived',
    })
    expect(loadApiConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false)
    expect(loadApiConfig({ TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy).toEqual(['loopback', '10.0.0.0/8'])
    expect(loadWorkerConfig({ KAFKA_BROKERS: 'kafka:9092, ' }).kafkaBrokers).toEqual(['kafka:9092'])
  })

  it('stop the process on a value that cannot work', () => {
    expect(() => loadCoreConfig({ ...NEEDED, HOT_ACCOUNT_MODE: 'serializable' })).toThrow('HOT_ACCOUNT_MODE must be one of sharded, derived, locked')
    expect(() => loadCoreConfig({ ...NEEDED, CURRENCIES: 'eur' })).toThrow('CURRENCIES must be a comma-separated list of currency codes')
    expect(() => loadCoreConfig({ ...NEEDED, RECON_FALLBACK: 'any' })).toThrow('RECON_FALLBACK must be one of unique, oldest, none')
    expect(() => loadApiConfig({ SESSION_HOURS: '0' })).toThrow('SESSION_HOURS must be a positive integer')
    expect(() => loadWorkerConfig({ AUDIT_BATCH: '1e3' })).toThrow('AUDIT_BATCH must be a non-negative integer')
  })
})
