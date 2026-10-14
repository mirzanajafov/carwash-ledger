SET lock_timeout = '2s';

ALTER TABLE "entries" VALIDATE CONSTRAINT "entries_currency_present";
