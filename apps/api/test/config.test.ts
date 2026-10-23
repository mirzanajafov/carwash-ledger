import { describe, expect, it } from 'vitest'
import { loadApiConfig, loadCoreConfig, loadWorkerConfig } from '../src/config.ts'

const NEEDED = { DATABASE_URL: 'postgresql://ledger', PSP_URL: 'http://psp', PSP_API_KEY: 'sk_test' }

describe('the settings each process reads', () => {
  it('need the database and the bank, and take defaults for the rest', () => {
    expect(() => loadCoreConfig({ ...NEEDED, PSP_API_KEY: '' })).toThrow('PSP_API_KEY is required')
    expect(loadCoreConfig(NEEDED)).toMatchObject({
      currencies: ['EUR'],
      hotAccountMode: 'sharded',
      fees: { bps: 200, fixed: 10n },
      pspFees: { bps: 120n, fixed: 8n },
      reconFallback: 'unique',
      witnessUrl: undefined,
    })
    expect(loadWorkerConfig({})).toMatchObject({ port: 3144, relayWorkers: 4, relayIdleMaxMs: 1000, kafkaBrokers: [] })
    expect(loadApiConfig({})).toMatchObject({ port: 3140, trustProxy: ['loopback'], sessionHours: 12 })
  })

  it('read lists trimmed and without empty items, an empty mode as the default, and TRUST_PROXY=false as no proxy', () => {
    expect(loadCoreConfig({ ...NEEDED, CURRENCIES: 'EUR, USD', HOT_ACCOUNT_MODE: 'derived' })).toMatchObject({
      currencies: ['EUR', 'USD'],
      hotAccountMode: 'derived',
    })
    expect(loadCoreConfig({ ...NEEDED, HOT_ACCOUNT_MODE: '', RECON_FALLBACK: '' })).toMatchObject({ hotAccountMode: 'sharded', reconFallback: 'unique' })
    expect(loadApiConfig({ TRUST_PROXY: ' false ' }).trustProxy).toBe(false)
    expect(loadApiConfig({ TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy).toEqual(['loopback', '10.0.0.0/8'])
    expect(loadWorkerConfig({ KAFKA_BROKERS: 'kafka:9092, ' }).kafkaBrokers).toEqual(['kafka:9092'])
  })

  it('stop the process on a value that cannot work', () => {
    expect(() => loadCoreConfig({ ...NEEDED, HOT_ACCOUNT_MODE: 'serializable' })).toThrow('HOT_ACCOUNT_MODE must be one of sharded, derived, locked')
    for (const currencies of ['eur', ' , ', 'EUR,EUR']) {
      expect(() => loadCoreConfig({ ...NEEDED, CURRENCIES: currencies })).toThrow('CURRENCIES must be a comma-separated list of different currency codes')
    }
    expect(() => loadCoreConfig({ ...NEEDED, HOT_ACCOUNT_SHARDS: '300' })).toThrow('HOT_ACCOUNT_SHARDS must be at most 256')
    for (const name of ['DATABASE_POOL_SIZE', 'DATABASE_CONNECT_TIMEOUT_MS', 'TRANSACTION_TIMEOUT_MS', 'PSP_TIMEOUT_MS', 'HOT_ACCOUNT_SHARDS']) {
      expect(() => loadCoreConfig({ ...NEEDED, [name]: '0' })).toThrow(`${name} must be a positive integer`)
    }
    expect(() => loadWorkerConfig({ WITNESS_URL: 'http://witness' })).toThrow('WITNESS_TOKEN is required when WITNESS_URL is set')
    expect(() => loadCoreConfig({ ...NEEDED, RECON_FALLBACK: 'any' })).toThrow('RECON_FALLBACK must be one of unique, oldest, none')
    for (const name of ['RATE_LIMIT_PER_KEY', 'RATE_LIMIT_PER_IP', 'LIVE_EVERY_MS', 'SESSION_HOURS']) {
      expect(() => loadApiConfig({ [name]: '0' })).toThrow(`${name} must be a positive integer`)
    }
    for (const name of ['RELAY_WORKERS', 'RELAY_IDLE_MAX_MS', 'AUDIT_BATCH', 'WITNESS_TIMEOUT_MS', 'CHECKPOINT_EVERY_LEAVES']) {
      expect(() => loadWorkerConfig({ [name]: '0' })).toThrow(`${name} must be a positive integer`)
    }
    expect(() => loadWorkerConfig({ AUDIT_BATCH: '1e3' })).toThrow('AUDIT_BATCH must be a positive integer')
  })
})
