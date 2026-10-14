SET lock_timeout = '2s';

ALTER TABLE "entries" ADD COLUMN "currency" CHAR(3);

CREATE FUNCTION ledger_entry_currency() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT currency INTO NEW.currency FROM accounts WHERE id = NEW.account_id;
  RETURN NEW;
END
$$;

CREATE TRIGGER entries_currency BEFORE INSERT ON "entries"
FOR EACH ROW EXECUTE FUNCTION ledger_entry_currency();
