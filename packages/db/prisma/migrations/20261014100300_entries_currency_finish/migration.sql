SET lock_timeout = '2s';

ALTER TABLE "entries" ALTER COLUMN "currency" SET NOT NULL;

ALTER TABLE "entries" DROP CONSTRAINT "entries_currency_present";

CREATE OR REPLACE FUNCTION ledger_check_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  off record;
BEGIN
  SELECT e.currency, sum(e.amount) AS total INTO off
  FROM entries e
  WHERE e.journal_id = NEW.journal_id
  GROUP BY e.currency
  HAVING sum(e.amount) <> 0
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % does not balance in %: off by %', NEW.journal_id, off.currency, off.total
      USING ERRCODE = 'LG002';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER entries_protect ON "entries";

CREATE TRIGGER entries_protect BEFORE UPDATE OR DELETE ON "entries"
FOR EACH ROW EXECUTE FUNCTION ledger_protect('id', 'journal_id', 'account_id', 'amount', 'created_xid', 'currency');
