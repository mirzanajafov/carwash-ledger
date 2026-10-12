export const LOCK_BALANCES = `
SELECT b.account_id
FROM balances b
JOIN unnest($1::bigint[], $2::int[]) AS t(account_id, shard)
  ON b.account_id = t.account_id AND b.shard = t.shard
ORDER BY b.account_id, b.shard
FOR UPDATE OF b`

export const INSERT_JOURNAL = `
INSERT INTO journals (external_ref, reverses_id)
VALUES ($1, $2::bigint)
RETURNING id`

export const INSERT_ENTRIES = `
INSERT INTO entries (journal_id, account_id, amount)
SELECT $1::bigint, t.account_id, t.amount
FROM unnest($2::bigint[], $3::bigint[]) AS t(account_id, amount)`

export const APPLY_DELTAS = `
UPDATE balances AS b
SET amount = b.amount + t.delta, version = b.version + 1
FROM unnest($1::bigint[], $2::int[], $3::bigint[]) AS t(account_id, shard, delta)
WHERE b.account_id = t.account_id AND b.shard = t.shard`

export const POST_JOURNAL = `
WITH journal AS (
  INSERT INTO journals (external_ref, reverses_id)
  VALUES ($1, $2::bigint)
  RETURNING id
), inserted AS (
  INSERT INTO entries (journal_id, account_id, amount)
  SELECT journal.id, t.account_id, t.amount
  FROM journal, unnest($3::bigint[], $4::bigint[]) AS t(account_id, amount)
  RETURNING 1
), applied AS (
  UPDATE balances AS b
  SET amount = b.amount + t.delta, version = b.version + 1
  FROM unnest($5::bigint[], $6::int[], $7::bigint[]) AS t(account_id, shard, delta)
  WHERE b.account_id = t.account_id AND b.shard = t.shard
  RETURNING 1
)
SELECT journal.id, (SELECT count(*) FROM inserted) AS entries, (SELECT count(*) FROM applied) AS balances
FROM journal`

export const STORED_BALANCE = `
SELECT coalesce(sum(amount), 0)::text AS amount
FROM balances
WHERE account_id = $1`

export const DERIVED_BALANCE = `
SELECT (coalesce(s.amount, 0) + coalesce((
  SELECT sum(e.amount)
  FROM entries e
  WHERE e.account_id = $1 AND e.created_xid >= coalesce(s.horizon, '0'::xid8)
), 0))::text AS amount
FROM (SELECT 1) AS one
LEFT JOIN balance_snapshots s ON s.account_id = $1`

export const TAKE_SNAPSHOTS = `
INSERT INTO balance_snapshots AS snap (account_id, amount, horizon, taken_at)
SELECT a.id,
       coalesce(s.amount, 0) + coalesce((
         SELECT sum(e.amount)
         FROM entries e
         WHERE e.account_id = a.id
           AND e.created_xid >= coalesce(s.horizon, '0'::xid8)
           AND e.created_xid < $1::xid8
       ), 0),
       $1::xid8,
       now()
FROM accounts a
LEFT JOIN balance_snapshots s ON s.account_id = a.id
WHERE a.balance_mode = 'derived'
  AND (s.horizon IS NULL OR s.horizon < $1::xid8)
ON CONFLICT (account_id) DO UPDATE
SET amount = excluded.amount, horizon = excluded.horizon, taken_at = excluded.taken_at
WHERE snap.horizon < excluded.horizon`

export const SELECT_ACCOUNTS = `
SELECT id::text, code, type::text, currency, balance_mode::text, shards
FROM accounts
WHERE id = ANY($1::bigint[])`

export const SELECT_ACCOUNTS_BY_CODE = `
SELECT id::text, code, type::text, currency, balance_mode::text, shards
FROM accounts
WHERE code = ANY($1::text[])`

export const INSERT_ACCOUNT = `
INSERT INTO accounts (code, type, currency, balance_mode, shards)
VALUES ($1, $2::account_type, $3, $4::balance_mode, $5)
RETURNING id::text`

export const INSERT_BALANCE_ROWS = `
INSERT INTO balances (account_id, shard)
SELECT $1::bigint, s
FROM generate_series(0, $2::int - 1) AS s`

export const SELECT_JOURNAL_ENTRIES = `
SELECT account_id::text, amount::text
FROM entries
WHERE journal_id = $1
ORDER BY id`
