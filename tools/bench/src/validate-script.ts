import type { BalanceMode } from '@carwash/ledger'

export function pgbenchScript(mode: BalanceMode): string {
  const locks = mode === 'locked' ? 'ARRAY[:receivable, :fees, :m]::bigint[], ARRAY[0, 0, 0]::int[]' : 'ARRAY[:m]::bigint[], ARRAY[0]::int[]'
  const deltas =
    mode === 'locked'
      ? 'ARRAY[:receivable, :m, :fees]::bigint[], ARRAY[0, 0, 0]::int[], ARRAY[:gross, :nneg, :fneg]::bigint[]'
      : 'ARRAY[:m]::bigint[], ARRAY[0]::int[], ARRAY[:nneg]::bigint[]'
  return `\\set m random(:mlo, :mhi)
\\set gross random(500, 3499)
\\set fee :gross / 50 + 10
\\set nneg :fee - :gross
\\set fneg -1 * :fee
BEGIN;
SELECT b.account_id FROM balances b
JOIN unnest(${locks}) AS t(account_id, shard) ON b.account_id = t.account_id AND b.shard = t.shard
ORDER BY b.account_id, b.shard FOR UPDATE OF b;
WITH journal AS (
  INSERT INTO journals (external_ref, reverses_id) VALUES ('pgbench:' || gen_random_uuid()::text, NULL) RETURNING id
), inserted AS (
  INSERT INTO entries (journal_id, account_id, amount)
  SELECT journal.id, t.account_id, t.amount
  FROM journal, unnest(ARRAY[:receivable, :m, :fees]::bigint[], ARRAY[:gross, :nneg, :fneg]::bigint[]) AS t(account_id, amount)
  RETURNING 1
), applied AS (
  UPDATE balances AS b SET amount = b.amount + t.delta, version = b.version + 1
  FROM unnest(${deltas}) AS t(account_id, shard, delta)
  WHERE b.account_id = t.account_id AND b.shard = t.shard
  RETURNING 1
)
SELECT journal.id, (SELECT count(*) FROM inserted), (SELECT count(*) FROM applied) FROM journal;
COMMIT;
`
}
