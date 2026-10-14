SET lock_timeout = '2s';

UPDATE "entries" e SET "currency" = a."currency" FROM "accounts" a WHERE a."id" = e."account_id" AND e."currency" IS NULL;

ALTER TABLE "entries" ADD CONSTRAINT "entries_currency_present" CHECK ("currency" IS NOT NULL) NOT VALID;
