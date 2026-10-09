CREATE TYPE "account_type" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

CREATE TYPE "balance_mode" AS ENUM ('locked', 'serializable', 'derived', 'sharded');

CREATE TABLE "accounts" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "type" "account_type" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "balance_mode" "balance_mode" NOT NULL,
    "shards" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "journals" (
    "id" BIGSERIAL NOT NULL,
    "external_ref" TEXT NOT NULL,
    "reverses_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "created_xid" xid8 NOT NULL DEFAULT pg_current_xact_id(),

    CONSTRAINT "journals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "entries" (
    "id" BIGSERIAL NOT NULL,
    "journal_id" BIGINT NOT NULL,
    "account_id" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_xid" xid8 NOT NULL DEFAULT pg_current_xact_id(),

    CONSTRAINT "entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "balances" (
    "account_id" BIGINT NOT NULL,
    "shard" INTEGER NOT NULL DEFAULT 0,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "version" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "balances_pkey" PRIMARY KEY ("account_id","shard")
);

CREATE TABLE "balance_snapshots" (
    "account_id" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,
    "horizon" xid8 NOT NULL,
    "taken_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_snapshots_pkey" PRIMARY KEY ("account_id")
);

CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");

CREATE UNIQUE INDEX "journals_external_ref_key" ON "journals"("external_ref");

CREATE UNIQUE INDEX "journals_reverses_id_key" ON "journals"("reverses_id");

CREATE INDEX "entries_journal_id_idx" ON "entries"("journal_id");

CREATE INDEX "entries_account_id_created_xid_idx" ON "entries"("account_id", "created_xid");

ALTER TABLE "journals" ADD CONSTRAINT "journals_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "journals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "entries" ADD CONSTRAINT "entries_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "entries" ADD CONSTRAINT "entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "balances" ADD CONSTRAINT "balances_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_code_length" CHECK (char_length("code") BETWEEN 1 AND 200);
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_shards_range" CHECK ("shards" BETWEEN 1 AND 256);
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_shards_mode" CHECK ("balance_mode" = 'sharded' OR "shards" = 1);
ALTER TABLE "journals" ADD CONSTRAINT "journals_external_ref_length" CHECK (char_length("external_ref") BETWEEN 1 AND 200);
ALTER TABLE "entries" ADD CONSTRAINT "entries_amount_nonzero" CHECK ("amount" <> 0);
ALTER TABLE "balances" ADD CONSTRAINT "balances_shard_range" CHECK ("shard" >= 0);

CREATE FUNCTION ledger_protect() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'LG001';
  END IF;
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF to_jsonb(OLD) -> col IS DISTINCT FROM to_jsonb(NEW) -> col THEN
      RAISE EXCEPTION '%.% cannot change', TG_TABLE_NAME, col USING ERRCODE = 'LG001';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER accounts_protect BEFORE UPDATE OR DELETE ON "accounts"
FOR EACH ROW EXECUTE FUNCTION ledger_protect('id', 'code', 'type', 'currency', 'balance_mode', 'shards');
CREATE TRIGGER accounts_no_truncate BEFORE TRUNCATE ON "accounts"
FOR EACH STATEMENT EXECUTE FUNCTION ledger_protect();

CREATE TRIGGER journals_protect BEFORE UPDATE OR DELETE ON "journals"
FOR EACH ROW EXECUTE FUNCTION ledger_protect('id', 'external_ref', 'reverses_id', 'created_at', 'created_xid');
CREATE TRIGGER journals_no_truncate BEFORE TRUNCATE ON "journals"
FOR EACH STATEMENT EXECUTE FUNCTION ledger_protect();

CREATE TRIGGER entries_protect BEFORE UPDATE OR DELETE ON "entries"
FOR EACH ROW EXECUTE FUNCTION ledger_protect('id', 'journal_id', 'account_id', 'amount', 'created_xid');
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON "entries"
FOR EACH STATEMENT EXECUTE FUNCTION ledger_protect();

CREATE FUNCTION ledger_stamp_journal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_xid := pg_current_xact_id();
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER journals_stamp BEFORE INSERT ON "journals"
FOR EACH ROW EXECUTE FUNCTION ledger_stamp_journal();

CREATE FUNCTION ledger_stamp_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_xid := pg_current_xact_id();
  IF NOT EXISTS (SELECT 1 FROM journals WHERE id = NEW.journal_id AND created_xid = NEW.created_xid) THEN
    RAISE EXCEPTION 'journal % was not created in this transaction', NEW.journal_id USING ERRCODE = 'LG004';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER entries_stamp BEFORE INSERT ON "entries"
FOR EACH ROW EXECUTE FUNCTION ledger_stamp_entry();

CREATE FUNCTION ledger_check_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  off record;
BEGIN
  SELECT a.currency, sum(e.amount) AS total INTO off
  FROM entries e
  JOIN accounts a ON a.id = e.account_id
  WHERE e.journal_id = NEW.journal_id
  GROUP BY a.currency
  HAVING sum(e.amount) <> 0
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % does not balance in %: off by %', NEW.journal_id, off.currency, off.total
      USING ERRCODE = 'LG002';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON "entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ledger_check_balance();

CREATE FUNCTION ledger_check_entry_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM entries WHERE journal_id = NEW.id) < 2 THEN
    RAISE EXCEPTION 'journal % has fewer than two entries', NEW.id USING ERRCODE = 'LG003';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journals_min_entries AFTER INSERT ON "journals"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_count();

GRANT SELECT, INSERT ON "accounts", "journals", "entries" TO ledger_app;
GRANT SELECT, INSERT, UPDATE ON "balances", "balance_snapshots" TO ledger_app;
GRANT USAGE ON SEQUENCE "accounts_id_seq", "journals_id_seq", "entries_id_seq" TO ledger_app;
GRANT SELECT ON "accounts", "journals", "entries", "balances", "balance_snapshots" TO ledger_audit;
