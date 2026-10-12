import { checkout } from '@carwash/pg'
import type pg from 'pg'

const MIGRATION_LOCK_KEY = 7_240_100

const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE charges (
  id text PRIMARY KEY,
  token text NOT NULL,
  currency char(3) NOT NULL,
  authorized_amount bigint NOT NULL CHECK (authorized_amount > 0),
  captured_amount bigint NOT NULL DEFAULT 0,
  refunded_amount bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('authorized', 'captured', 'canceled')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (captured_amount <= authorized_amount),
  CHECK (refunded_amount <= captured_amount)
);

CREATE TABLE operations (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('authorize', 'capture', 'cancel', 'refund', 'payout')),
  status text NOT NULL CHECK (status IN ('succeeded', 'declined')),
  reason text,
  charge_id text REFERENCES charges (id),
  amount bigint,
  currency char(3),
  destination text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operations_by_key ON operations (idempotency_key, created_at DESC);
CREATE INDEX operations_by_charge ON operations (charge_id, created_at);

CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  request_hash bytea NOT NULL,
  operation_id text NOT NULL REFERENCES operations (id),
  http_status int NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idempotency_keys_by_age ON idempotency_keys (created_at);

CREATE TABLE events (
  id text PRIMARY KEY,
  operation_id text NOT NULL REFERENCES operations (id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL REFERENCES events (id),
  due_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  dropped boolean NOT NULL DEFAULT false,
  delivered_at timestamptz,
  failed_at timestamptz,
  last_error text
);

CREATE INDEX deliveries_due ON deliveries (due_at, id) WHERE delivered_at IS NULL AND failed_at IS NULL AND NOT dropped;
`,
]

export async function migrate(pool: pg.Pool): Promise<number> {
  const lease = await checkout(pool)
  const { client } = lease
  let broken = false
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY])
    await client.query('CREATE TABLE IF NOT EXISTS psp_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    const { rows } = await client.query<{ version: number | null }>('SELECT max(version) AS version FROM psp_migrations')
    const current = rows[0]?.version ?? 0
    for (let version = current + 1; version <= MIGRATIONS.length; version++) {
      await client.query(MIGRATIONS[version - 1]!)
      await client.query('INSERT INTO psp_migrations (version) VALUES ($1)', [version])
    }
    await client.query('COMMIT')
    return MIGRATIONS.length - current
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      broken = true
    })
    throw error
  } finally {
    lease.release(broken)
  }
}
